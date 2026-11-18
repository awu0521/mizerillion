// Admin API: /api/admin/*. Separate password (ADMIN_PASSWORD_HASH), sessions, cookie and lockouts
// from players; a player session never counts as an admin session or the other way round.
//
// Sessions: random 32-byte token in the __Host-admin cookie (HttpOnly, Secure, SameSite=Strict),
// only its SHA-256 hash stored; 30 minutes idle or 8 hours total; a new ADMIN_PASSWORD_HASH ends them.
// Every change needs POST + this site's Origin + the session's X-CSRF-Token, and is audited.
import { TIER_KEYS, normalize, gameDate, dayNumber } from '../public/rules.mjs';
import { verifyPassword, sha256hex, randomToken, TOKEN_FORMAT, fingerprint, csrfFor, timingSafeEqual } from './auth.mjs';
import { lockedUntil, ipLockedUntil, globalLockedUntil, LIMITS } from './lockout.mjs';
import { choosePuzzleIds } from './puzzle.mjs';
import { json, fail, iso, addDays, clientIp, readCookie, waitText, readJson } from './http.mjs';

export const ADMIN_IDLE_MS = 30 * 60e3;
export const ADMIN_MAX_MS = 8 * 3600e3;
const MAX_BODY = 16000;
const PROMPT_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_ALIASES = 50, MAX_ALIAS_LENGTH = 80, MAX_ANSWER = 120, MAX_QUIP = 200, MAX_PROMPT_TEXT = 200;
const CATEGORY = /^[a-z][a-z0-9 -]{0,29}$/;
const cleanText = v => typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : null;
/** A readable id from the question: "Name a show we argued about" -> "name-a-show-we-argued-about". */
export function slugify(text) {
  const slug = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug || 'prompt';
}
function checkAnswerText(v) {
  const text = cleanText(v);
  if (!text || text.length > MAX_ANSWER) return { error: `An answer needs 1 to ${MAX_ANSWER} characters.` };
  if (!normalize(text)) return { error: `"${text}" has no letters, numbers or emoji, so nobody could type it. Use words, or add the emoji itself.` };
  return { text };
}
function checkQuip(v) {
  if (v === undefined || v === null || v === '') return { text: '' }; // no quip
  const text = cleanText(v);
  if (text === null || text.length > MAX_QUIP) return { error: `A quip can be at most ${MAX_QUIP} characters.` };
  return { text };
}
function cleanAliases(list) {
  if (!Array.isArray(list) || list.length > MAX_ALIASES || !list.every(x => typeof x === 'string')) return { error: `Aliases must be a list of up to ${MAX_ALIASES} pieces of text.` };
  const aliases = [...new Set(list.map(cleanText).filter(Boolean))];
  const tooLong = aliases.find(x => x.length > MAX_ALIAS_LENGTH);
  if (tooLong) return { error: `Aliases can be at most ${MAX_ALIAS_LENGTH} characters.` };
  const untypeable = aliases.find(x => !normalize(x));
  if (untypeable) return { error: `"${untypeable}" has no letters, numbers or emoji, so it can never match.` };
  return { aliases };
}
/** The answer that `text` would already match in this prompt (ignoring `except`), or null. */
function clashWith(text, p, except) {
  const key = normalize(text);
  for (const other of p.answers) if (other !== except) for (const w of [other.answer, ...(other.aliases || [])]) if (normalize(w) === key) return other.answer;
  return null;
}
/** Aliases for one answer: no clashes with other answers, no duplicates, none equal to the answer itself. */
function checkAliases(aliases, p, a, answerText) {
  const clash = aliases.find(x => clashWith(x, p, a));
  if (clash) return { error: `"${clash}" already matches "${clashWith(clash, p, a)}".` };
  const own = normalize(answerText), seen = new Set(), out = [];
  for (const x of aliases) { const k = normalize(x); if (k !== own && !seen.has(k)) { seen.add(k); out.push(x); } }
  return { aliases: out };
}

export const adminCookieName = url => url.protocol === 'https:' ? '__Host-admin' : 'admin_dev';
function adminCookie(url, token, maxAgeMs) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${adminCookieName(url)}=${token}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

/** Tier counts and the non-blocking warnings shown in the editor. */
export function promptSummary(p) {
  const counts = Object.fromEntries(TIER_KEYS.map(k => [k, 0]));
  for (const a of p.answers) if (counts[a.tier] !== undefined) counts[a.tier]++;
  const warnings = [];
  if (counts.krillion === 0) warnings.push('No One in a Krillion answer.');
  if (counts.krillion > 1) warnings.push(`${counts.krillion} One in a Krillion answers (usually there's one).`);
  if (counts.plankton === 0) warnings.push('No Plankton answer.');
  return { id: p.id, text: p.text, category: p.category, enabled: !!p.enabled, needsReview: !!p.needs_review, answerCount: p.answers.length, counts, warnings };
}
const promptDetail = p => ({
  ...promptSummary(p), note: p.note ?? null, version: p.version, createdHere: !!p.created_by_admin,
  answers: p.answers.map(a => ({ answer: a.answer, aliases: a.aliases || [], tier: a.tier, weight: a.weight ?? null, quip: a.quip ?? null, autoPick: !!a.auto_pick, addedHere: !!a.added_by_admin })),
});

/** Rejects anything but exactly these fields. */
function fields(data, allowed) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Invalid request.';
  const extra = Object.keys(data).filter(k => !allowed.includes(k));
  return extra.length ? `Unknown field: ${extra.join(', ')}` : null;
}

export function createAdminApi({ store, now = () => Date.now() }) {
  const fingerprints = new Map();
  async function passwordFingerprint(env) {
    const stored = env.ADMIN_PASSWORD_HASH || '';
    if (!fingerprints.has(stored)) fingerprints.set(stored, await fingerprint(stored));
    return fingerprints.get(stored);
  }
  // No caching: every admin request checks the session in the database.
  async function adminSession(request, url, env) {
    const token = readCookie(request, adminCookieName(url));
    if (!token || !TOKEN_FORMAT.test(token)) return null;
    const tokenHash = await sha256hex(token), row = await store.getSession('admin', tokenHash), t = now();
    if (!row || row.revoked) return null;
    if (Date.parse(row.expires_at) <= t) return null;                  // 8 hours total
    if (Date.parse(row.last_seen) + ADMIN_IDLE_MS <= t) return null;   // 30 minutes idle
    if (!timingSafeEqual(row.password_fp, await passwordFingerprint(env))) return null; // hash changed
    return { token, tokenHash, row };
  }
  const audit = (request, session, action, extra = {}) => store.addAudit({
    session_id: session?.row?.id ?? session?.id ?? null, ip: clientIp(request), action,
    prompt_id: extra.promptId ?? null, answer: extra.answer ?? null,
    old_value: extra.old === undefined ? null : extra.old, new_value: extra.new === undefined ? null : extra.new,
    created_at: iso(now()),
  });

  async function login(request, url, env, password) {
    const t = now(), ip = clientIp(request);
    const until = await lockedUntil(store, 'admin', ip, t);
    if (until > t) {
      await audit(request, null, 'login_blocked');
      return fail(`Too many attempts. Try again in ${waitText(until - t)}.`, 429, {}, { 'Retry-After': String(Math.ceil((until - t) / 1000)) });
    }
    if (!env.ADMIN_PASSWORD_HASH) console.error('ADMIN_PASSWORD_HASH is not set; nobody can log in as admin.');
    const ok = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);
    await store.recordLoginAttempt('admin', { ip, success: ok, created_at: iso(t) });
    if (!ok) { await audit(request, null, 'login_failed'); return fail('Wrong password', 401); }
    const token = randomToken(), id = crypto.randomUUID();
    await store.createSession('admin', {
      token_hash: await sha256hex(token), id, password_fp: await passwordFingerprint(env),
      ip, user_agent: (request.headers.get('User-Agent') || '').slice(0, 256),
      created_at: iso(t), last_seen: iso(t), expires_at: iso(t + ADMIN_MAX_MS),
    });
    await audit(request, { id }, 'login');
    return json({ ok: true }, 200, { 'Set-Cookie': adminCookie(url, token, ADMIN_MAX_MS) });
  }

  /** Read-modify-write of one prompt, retried if someone else saved it in between. */
  async function editPrompt(promptId, change) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = await store.promptFull(promptId);
      if (!p) return { error: fail('No such prompt.', 404) };
      const result = change(p);
      if (result.error) return result;
      if (result.unchanged) return { prompt: p, unchanged: true };
      const saved = await store.updatePrompt(promptId, p.version, result.patch, iso(now()));
      if (saved) return { prompt: saved, old: result.old, new: result.new };
    }
    return { error: fail('Someone else just changed this prompt. Reload it and try again.', 409) };
  }

  /** Who is locked out right now, worked out from the attempt log with the same rules as login. */
  async function lockouts() {
    const t = now(), out = {};
    for (const kind of ['player', 'admin']) {
      const rows = await store.attemptsSince(kind, iso(t - LIMITS.ipHistory));
      const byIp = new Map();
      for (const r of rows) { if (!byIp.has(r.ip)) byIp.set(r.ip, []); byIp.get(r.ip).push({ at: Date.parse(r.created_at), success: r.success }); }
      const ips = [];
      for (const [ip, list] of byIp) { const until = ipLockedUntil(list); if (until > t) ips.push({ ip, until, failures: list.filter(x => !x.success).length }); }
      const globalUntil = globalLockedUntil(rows.filter(r => !r.success && Date.parse(r.created_at) >= t - 2 * LIMITS.globalWindow).map(r => Date.parse(r.created_at)));
      out[kind] = { ips: ips.sort((a, b) => b.until - a.until), globalUntil: globalUntil > t ? globalUntil : null };
    }
    return { ...out, serverNow: t };
  }

  async function preview() {
    const today = gameDate(now()), tomorrow = addDays(today, 1);
    const stored = await store.getPuzzle(today);
    const todayIds = stored?.prompt_ids || await choosePuzzleIds(store, today);
    const tomorrowStored = await store.getPuzzle(tomorrow);
    const tomorrowIds = tomorrowStored?.prompt_ids || await choosePuzzleIds(store, tomorrow, stored ? [] : [{ date: today, prompt_ids: todayIds }]);
    const prompts = new Map((await store.promptsByIds([...new Set([...todayIds, ...tomorrowIds])])).map(p => [p.id, p]));
    const day = (date, ids, fixed) => ({ date, dayNumber: dayNumber(date), fixed, prompts: ids.map(id => ({ id, text: prompts.get(id)?.text ?? '(missing prompt)', category: prompts.get(id)?.category ?? '' })) });
    return { today: day(today, todayIds, !!stored), tomorrow: day(tomorrow, tomorrowIds, !!tomorrowStored) };
  }

  async function handle(request, url, env) {
    const path = url.pathname.slice('/api/admin/'.length), method = request.method;
    const mutating = MUTATING.includes(method);
    if (!mutating && method !== 'GET') return fail('Method not allowed.', 405);
    let data;
    if (mutating) {
      if (request.headers.get('Origin') !== url.origin) return fail('Cross-origin requests are not accepted.', 403);
      const body = await readJson(request, MAX_BODY);
      if (body.error) return body.error;
      data = body.data;
      if (path === 'login' && method === 'POST') return login(request, url, env, data && typeof data === 'object' ? data.password : undefined);
    }
    const session = await adminSession(request, url, env);
    if (path === 'session' && method === 'GET') {
      if (!session) return json({ authenticated: false });
    } else if (!session) return fail('Admin only.', 401);
    if (mutating && !timingSafeEqual(request.headers.get('X-CSRF-Token') || '', await csrfFor(session.token, 'admin'))) return fail('Invalid request.', 403);
    // Any admin request counts as activity for the 30-minute idle limit.
    const t = now();
    await store.updateSession('admin', session.tokenHash, { last_seen: iso(t) });
    const expiresAt = Math.min(Date.parse(session.row.expires_at), t + ADMIN_IDLE_MS);

    if (method === 'GET') {
      if (path === 'session') return json({ authenticated: true, csrf: await csrfFor(session.token, 'admin'), expiresAt, absoluteExpiresAt: Date.parse(session.row.expires_at), idleMs: ADMIN_IDLE_MS, serverNow: t });
      if (path === 'prompts') return json({ prompts: (await store.adminPrompts()).map(promptSummary) });
      if (path === 'prompt') {
        const id = url.searchParams.get('id') || '';
        if (!PROMPT_ID.test(id)) return fail('No such prompt.', 404);
        const [p, guesses] = await Promise.all([store.promptFull(id), store.rejectedGuesses(id, 30)]);
        if (!p) return fail('No such prompt.', 404);
        return json({ prompt: promptDetail(p), guesses: guesses.map(g => ({ normalized: g.normalized, example: g.example, count: g.count, lastSeen: g.last_seen })) });
      }
      if (path === 'audit') return json({ entries: (await store.recentAudit(150)).map(e => ({ id: e.id, action: e.action, promptId: e.prompt_id, answer: e.answer, oldValue: e.old_value, newValue: e.new_value, ip: e.ip, at: e.created_at, mine: e.session_id === session.row.id })) });
      if (path === 'preview') return json(await preview());
      if (path === 'lockouts') return json(await lockouts());
      return fail('Unknown endpoint.', 404);
    }

    // Changes. All are POST; PUT/PATCH/DELETE pass the checks above but have no routes.
    if (method !== 'POST') return fail('Unknown endpoint.', 404);
    if (path === 'logout') {
      const bad = fields(data ?? {}, []); if (bad) return fail(bad);
      await store.updateSession('admin', session.tokenHash, { revoked: true });
      await audit(request, session, 'logout');
      return json({ ok: true }, 200, { 'Set-Cookie': adminCookie(url, '', 0) });
    }
    if (path === 'tier') {
      const bad = fields(data, ['promptId', 'answer', 'tier']); if (bad) return fail(bad);
      const { promptId, answer, tier } = data;
      if (typeof promptId !== 'string' || !PROMPT_ID.test(promptId)) return fail('No such prompt.', 404);
      if (typeof answer !== 'string' || answer.length > 256) return fail('No such answer.');
      if (!TIER_KEYS.includes(tier)) return fail(`Tier must be one of: ${TIER_KEYS.join(', ')}.`);
      const r = await editPrompt(promptId, p => {
        const a = p.answers.find(x => x.answer === answer);
        if (!a) return { error: fail('No such answer.') };
        if (a.tier === tier) return { unchanged: true };
        return { patch: { answers: p.answers.map(x => x === a ? { ...x, tier } : x) }, old: a.tier, new: tier };
      });
      if (r.error) return r.error;
      if (!r.unchanged) await audit(request, session, 'tier', { promptId, answer, old: r.old, new: r.new });
      return json({ prompt: promptDetail(r.prompt), oldTier: r.old ?? tier });
    }
    const promptIdOk = id => typeof id === 'string' && PROMPT_ID.test(id);
    const answerOk = a => typeof a === 'string' && a.length <= 256;

    if (path === 'unlock') {
      // Lifts login lockouts early by clearing failed attempts: one IP, or everyone (also ends a global lockout).
      const bad = fields(data, ['kind', 'ip']); if (bad) return fail(bad);
      const { kind, ip } = data;
      if (!['player', 'admin'].includes(kind)) return fail('kind must be "player" or "admin".');
      if (ip !== undefined && (typeof ip !== 'string' || !ip || ip.length > 64)) return fail('ip must be an address from the lockout list.');
      await store.clearFailedAttempts(kind, ip ?? null);
      await audit(request, session, 'unlock', { new: { kind, ip: ip ?? 'everyone' } });
      return json(await lockouts());
    }
    if (path === 'aliases') {
      const bad = fields(data, ['promptId', 'answer', 'aliases']); if (bad) return fail(bad);
      const { promptId, answer } = data;
      if (!promptIdOk(promptId)) return fail('No such prompt.', 404);
      if (!answerOk(answer)) return fail('No such answer.');
      const list = cleanAliases(data.aliases); if (list.error) return fail(list.error);
      const r = await editPrompt(promptId, p => {
        const a = p.answers.find(x => x.answer === answer);
        if (!a) return { error: fail('No such answer.') };
        const next = checkAliases(list.aliases, p, a, a.answer); if (next.error) return { error: fail(next.error) };
        const before = a.aliases || [];
        if (JSON.stringify(before) === JSON.stringify(next.aliases)) return { unchanged: true };
        return { patch: { answers: p.answers.map(x => x === a ? { ...x, aliases: next.aliases } : x) }, old: before, new: next.aliases };
      });
      if (r.error) return r.error;
      if (!r.unchanged) await audit(request, session, 'aliases', { promptId, answer, old: r.old, new: r.new });
      return json({ prompt: promptDetail(r.prompt) });
    }
    if (path === 'enabled') {
      const bad = fields(data, ['promptId', 'enabled']); if (bad) return fail(bad);
      const { promptId, enabled } = data;
      if (!promptIdOk(promptId)) return fail('No such prompt.', 404);
      if (typeof enabled !== 'boolean') return fail('enabled must be true or false.');
      const r = await editPrompt(promptId, p => {
        if (p.enabled === enabled) return { unchanged: true };
        if (enabled && !p.answers.length) return { error: fail('Add at least one answer before switching this prompt on.') };
        return { patch: { enabled }, old: p.enabled, new: enabled };
      });
      if (r.error) return r.error;
      if (!r.unchanged) await audit(request, session, 'enabled', { promptId, old: r.old, new: r.new });
      return json({ prompt: promptDetail(r.prompt) });
    }

    // New prompt: starts switched off and with no answers.
    if (path === 'create-prompt') {
      const bad = fields(data, ['text', 'category']); if (bad) return fail(bad);
      const text = cleanText(data.text), category = cleanText(data.category)?.toLowerCase();
      if (!text || text.length > MAX_PROMPT_TEXT) return fail(`The question needs 1 to ${MAX_PROMPT_TEXT} characters.`);
      if (!category || !CATEGORY.test(category)) return fail('The category needs 1 to 30 letters, numbers, spaces or dashes, starting with a letter.');
      const base = slugify(text);
      for (let n = 1; n <= 50; n++) {
        const id = n === 1 ? base : `${base.slice(0, 76)}-${n}`;
        const row = { id, text, category, answers: [], enabled: false, needs_review: false, created_by_admin: true, text_edited: false, removed_answers: [], version: 0, updated_at: iso(now()) };
        if (await store.createPrompt(row)) {
          await audit(request, session, 'create_prompt', { promptId: id, new: { text, category } });
          return json({ prompt: promptDetail(await store.promptFull(id)) });
        }
      }
      return fail('Could not find a free id for that question. Try rewording it.', 409);
    }
    if (path === 'edit-prompt') {
      const bad = fields(data, ['promptId', 'text', 'category']); if (bad) return fail(bad);
      const { promptId } = data;
      if (!promptIdOk(promptId)) return fail('No such prompt.', 404);
      if (data.text === undefined && data.category === undefined) return fail('Nothing to change.');
      const text = data.text === undefined ? undefined : cleanText(data.text);
      const category = data.category === undefined ? undefined : cleanText(data.category)?.toLowerCase();
      if (text !== undefined && (!text || text.length > MAX_PROMPT_TEXT)) return fail(`The question needs 1 to ${MAX_PROMPT_TEXT} characters.`);
      if (category !== undefined && (!category || !CATEGORY.test(category))) return fail('The category needs 1 to 30 letters, numbers, spaces or dashes, starting with a letter.');
      const r = await editPrompt(promptId, p => {
        const next = { text: text ?? p.text, category: category ?? p.category };
        if (next.text === p.text && next.category === p.category) return { unchanged: true };
        return { patch: { ...next, text_edited: true }, old: { text: p.text, category: p.category }, new: next };
      });
      if (r.error) return r.error;
      if (!r.unchanged) await audit(request, session, 'edit_prompt', { promptId, old: r.old, new: r.new });
      return json({ prompt: promptDetail(r.prompt) });
    }
    if (path === 'add-answer') {
      const bad = fields(data, ['promptId', 'answer', 'tier', 'aliases', 'quip']); if (bad) return fail(bad);
      const { promptId, tier } = data;
      if (!promptIdOk(promptId)) return fail('No such prompt.', 404);
      const answer = checkAnswerText(data.answer); if (answer.error) return fail(answer.error);
      if (!TIER_KEYS.includes(tier)) return fail('Pick a tier for the answer.');
      const list = cleanAliases(data.aliases ?? []); if (list.error) return fail(list.error);
      const quip = checkQuip(data.quip); if (quip.error) return fail(quip.error);
      const r = await editPrompt(promptId, p => {
        const clash = clashWith(answer.text, p, null); if (clash) return { error: fail(`"${answer.text}" already matches "${clash}".`) };
        const aliases = checkAliases(list.aliases, p, null, answer.text); if (aliases.error) return { error: fail(aliases.error) };
        const added = { answer: answer.text, tier, ...(aliases.aliases.length ? { aliases: aliases.aliases } : {}), ...(quip.text ? { quip: quip.text } : {}), added_by_admin: true };
        const key = normalize(answer.text);
        return { patch: { answers: [...p.answers, added], removed_answers: (p.removed_answers || []).filter(k => k !== key) }, new: { tier, aliases: aliases.aliases, quip: quip.text || null } };
      });
      if (r.error) return r.error;
      await audit(request, session, 'add_answer', { promptId, answer: answer.text, new: r.new });
      return json({ prompt: promptDetail(r.prompt) });
    }
    if (path === 'edit-answer') {
      const bad = fields(data, ['promptId', 'answer', 'newAnswer', 'aliases', 'quip']); if (bad) return fail(bad);
      const { promptId, answer } = data;
      if (!promptIdOk(promptId)) return fail('No such prompt.', 404);
      if (!answerOk(answer)) return fail('No such answer.');
      if (data.newAnswer === undefined && data.aliases === undefined && data.quip === undefined) return fail('Nothing to change.');
      const renamed = data.newAnswer === undefined ? null : checkAnswerText(data.newAnswer); if (renamed?.error) return fail(renamed.error);
      const list = data.aliases === undefined ? null : cleanAliases(data.aliases); if (list?.error) return fail(list.error);
      const quip = data.quip === undefined ? null : checkQuip(data.quip); if (quip?.error) return fail(quip.error);
      const r = await editPrompt(promptId, p => {
        const a = p.answers.find(x => x.answer === answer);
        if (!a) return { error: fail('No such answer.') };
        const next = { ...a };
        if (renamed && renamed.text !== a.answer) {
          const clash = clashWith(renamed.text, p, a); if (clash) return { error: fail(`"${renamed.text}" already matches "${clash}".`) };
          next.answer = renamed.text; next.renamed_from = a.renamed_from ?? a.answer; // the seed still recognises the original
        }
        if (list) {
          const aliases = checkAliases(list.aliases, p, a, next.answer); if (aliases.error) return { error: fail(aliases.error) };
          if (aliases.aliases.length) next.aliases = aliases.aliases; else delete next.aliases;
        } else if (next.aliases) next.aliases = next.aliases.filter(x => normalize(x) !== normalize(next.answer));
        if (quip && (quip.text || null) !== (a.quip ?? null)) { if (quip.text) next.quip = quip.text; else delete next.quip; next.quip_edited = true; }
        const view = x => ({ answer: x.answer, aliases: x.aliases || [], quip: x.quip ?? null });
        if (JSON.stringify(view(next)) === JSON.stringify(view(a))) return { unchanged: true };
        return { patch: { answers: p.answers.map(x => x === a ? next : x) }, old: view(a), new: view(next) };
      });
      if (r.error) return r.error;
      if (!r.unchanged) await audit(request, session, 'edit_answer', { promptId, answer, old: r.old, new: r.new });
      return json({ prompt: promptDetail(r.prompt) });
    }
    if (path === 'delete-answer') {
      const bad = fields(data, ['promptId', 'answer']); if (bad) return fail(bad);
      const { promptId, answer } = data;
      if (!promptIdOk(promptId)) return fail('No such prompt.', 404);
      if (!answerOk(answer)) return fail('No such answer.');
      const r = await editPrompt(promptId, p => {
        const a = p.answers.find(x => x.answer === answer);
        if (!a) return { error: fail('No such answer.') };
        if (p.enabled && p.answers.length === 1) return { error: fail('This is the last answer. Switch the prompt off before deleting it.') };
        // Bank answers deleted here are remembered so a re-seed doesn't bring them back.
        const removed = a.added_by_admin ? p.removed_answers || [] : [...new Set([...(p.removed_answers || []), normalize(a.renamed_from ?? a.answer)])];
        return { patch: { answers: p.answers.filter(x => x !== a), removed_answers: removed }, old: { tier: a.tier, aliases: a.aliases || [], quip: a.quip ?? null } };
      });
      if (r.error) return r.error;
      await audit(request, session, 'delete_answer', { promptId, answer, old: r.old });
      return json({ prompt: promptDetail(r.prompt) });
    }
    return fail('Unknown endpoint.', 404);
  }

  /** Whether this request has a valid admin session (used to send /admin with the right view showing). */
  const hasSession = async (request, url, env) => !!await adminSession(request, url, env);
  return { handle, hasSession };
}

