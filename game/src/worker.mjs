// Mizerillion Worker. Game flow ported from OpenKrillion's src/worker.mjs (MIT):
// the server owns the clock, the score and the answer sheet.
//
// Access: one shared player password (hash in the PLAYER_PASSWORD_HASH secret). After it, a player
// picks their name from `members`. Without a valid player session, the site shows only the password
// screen and every /api/* game route returns 401.
import { GAME } from '../public/site.mjs';
import { TIERS, ROUND_MS, PREVIEW_MS, GRACE_MS, ROUNDS, normalize, matchAnswer, gameDate, resetAt, dayNumber } from '../public/rules.mjs';
import { pickPrompts, cryptoRandom, choosePuzzleIds } from './puzzle.mjs';
import { verifyPassword, sha256hex, randomToken, TOKEN_FORMAT, fingerprint, csrfFor, timingSafeEqual } from './auth.mjs';
import { lockedUntil } from './lockout.mjs';
import { json, fail, iso, clientIp, readCookie, waitText, readJson } from './http.mjs';
import { createAdminApi } from './admin.mjs';
import { createSettings } from './settings.mjs';
import { signRun, readRun } from './preview.mjs';
import { gamePage, loginPage, adminPage } from './html.mjs';

const MAX_BODY = 8000;
export const PLAYER_SESSION_MS = 30 * 24 * 3600e3;
const SESSION_CACHE_MS = 30e3;      // re-check a session against the database at most every 30 s per isolate
const LAST_SEEN_EVERY_MS = 3600e3;
const UUID = /^[a-f0-9-]{36}$/;

// Security headers on every response. No inline scripts; the page's JSON config block is data, not script.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function securityHeaders(response, extra = {}) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries({
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains', 'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', ...extra,
  })) h.set(k, v);
  return new Response(response.body, { status: response.status, headers: h });
}

// __Host-play in production (HTTPS). Plain http://localhost can't hold a __Host-/Secure cookie in every
// browser, so local dev uses play_dev without Secure.
export const playerCookieName = url => url.protocol === 'https:' ? '__Host-play' : 'play_dev';
function playerCookie(url, token, maxAgeMs) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${playerCookieName(url)}=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

/**
 * Judges one submitted answer against a round (shared by real and preview dives).
 * Returns { raw, match } plus one of: rejected (no match, keep guessing), correction (confirm a typo),
 * or result (the round is scored).
 */
export function judgeAnswer(run, prompt, data, t) {
  const raw = typeof data.answer === 'string' ? data.answer.trim().slice(0, 256) : '';
  const late = t > run.round_start + ROUND_MS;
  // The grace period covers only the client's own timed submission; a late manual request
  // can't revive an expired round (it is scored as a miss).
  const timely = !late || (data.timeout === true && t <= run.round_start + ROUND_MS + GRACE_MS);
  const match = raw && timely ? matchAnswer(raw, prompt.answers) : null;
  if (!match && raw && !late && !data.timeout) return { raw, match, rejected: { rejected: true, message: `“${raw}”: no echo. try again` } };
  if (match?.correction && data.confirm !== true && !late && !data.timeout && data.previewCorrection !== false) return { raw, match, correction: { correction: match.answer, original: raw } };
  return { raw, match, result: { round: run.next_round, rawAnswer: raw || null, answer: match?.answer || null, tier: match?.tier || null, score: match ? TIERS[match.tier].score : 0 } };
}

export function createApp({ store, now = () => Date.now() }) {
  const sessionCache = new Map(), fingerprints = new Map(), settings = createSettings(store, now);
  async function passwordFingerprint(env) {
    const stored = env.PLAYER_PASSWORD_HASH || '';
    if (!fingerprints.has(stored)) fingerprints.set(stored, await fingerprint(stored));
    return fingerprints.get(stored);
  }

  /** The valid player session for this request, or null. */
  async function playerSession(request, url, env) {
    const token = readCookie(request, playerCookieName(url));
    if (!token || !TOKEN_FORMAT.test(token)) return null;
    const tokenHash = await sha256hex(token);
    let cached = sessionCache.get(tokenHash);
    if (!cached || now() - cached.at > SESSION_CACHE_MS) {
      cached = { row: await store.getSession('player', tokenHash), at: now() };
      if (cached.row) sessionCache.set(tokenHash, cached); else sessionCache.delete(tokenHash);
    }
    const row = cached.row;
    if (!row || row.revoked || Date.parse(row.expires_at) <= now()) return null;
    // A changed PLAYER_PASSWORD_HASH logs every player out.
    if (!timingSafeEqual(row.password_fp, await passwordFingerprint(env))) return null;
    const member = row.member_id && row.member_active ? { id: row.member_id, display_name: row.display_name } : null;
    return { token, tokenHash, row, member };
  }
  function forgetSession(tokenHash) { sessionCache.delete(tokenHash); }

  async function login(request, url, env, password) {
    const t = now(), ip = clientIp(request);
    const until = await lockedUntil(store, 'player', ip, t);
    if (until > t) return fail(`Too many attempts. Try again in ${waitText(until - t)}.`, 429, {}, { 'Retry-After': String(Math.ceil((until - t) / 1000)) });
    if (!env.PLAYER_PASSWORD_HASH) console.error('PLAYER_PASSWORD_HASH is not set; nobody can log in.');
    const ok = await verifyPassword(password, env.PLAYER_PASSWORD_HASH);
    await store.recordLoginAttempt('player', { ip, success: ok, created_at: iso(t) });
    if (!ok) return fail('Wrong password', 401);
    const token = randomToken();
    await store.createSession('player', {
      token_hash: await sha256hex(token), member_id: null, password_fp: await passwordFingerprint(env),
      ip, user_agent: (request.headers.get('User-Agent') || '').slice(0, 256),
      created_at: iso(t), last_seen: iso(t), expires_at: iso(t + PLAYER_SESSION_MS),
    });
    // The token goes only into the HttpOnly cookie, never into a response body.
    return json({ ok: true }, 200, { 'Set-Cookie': playerCookie(url, token, PLAYER_SESSION_MS) });
  }

  async function dailyPuzzle(date) {
    const existing = await store.getPuzzle(date);
    if (existing) return existing;
    return store.createPuzzle({ date, day_number: dayNumber(date, await settings.launchDate()), prompt_ids: await choosePuzzleIds(store, date) });
  }
  async function promptsFor(run) { return store.promptsByIds(run.prompt_ids); }

  // What the browser may see: prompt text only up to the current round, never answers.
  // Pass answers/prompts you already have; anything missing is fetched in parallel.
  async function state(run, have = {}) {
    const [answers, prompts, launch] = await Promise.all([have.answers || store.answersFor(run.id), have.prompts || promptsFor(run), settings.launchDate()]);
    const visible = run.completed ? ROUNDS : run.next_round + 1;
    return {
      date: run.date, dayNumber: run.mode === 'preview' ? 0 : dayNumber(run.date, launch), resetsAt: resetAt(run.date),
      runId: run.id, mode: run.mode, round: run.next_round, roundStart: run.round_start, pausedAt: run.paused_at || null,
      serverNow: now(), completed: !!run.completed,
      prompts: prompts.map((p, i) => i < visible ? { text: p.text } : null),
      results: answers.map(a => ({ round: a.round, rawAnswer: a.raw_answer, answer: a.answer, tier: a.tier, score: a.score })),
      score: answers.reduce((s, a) => s + a.score, 0),
    };
  }
  async function ownRun(id, member) {
    if (!UUID.test(id || '')) return null;
    const run = await store.getRun(id);
    return run && run.member_id === member.id ? run : null;
  }
  /** The member's run plus its scored rounds, fetched in parallel. */
  async function loadRun(id, member) {
    if (!UUID.test(id || '')) return null;
    const [run, answers] = await Promise.all([store.getRun(id), store.answersFor(id)]);
    return run && run.member_id === member.id ? { run, answers } : null;
  }

  // Game routes. Only reached with a valid player session and a picked name.
  async function gameApi(request, url, member, data, defer) {
    const path = url.pathname, date = gameDate(now());
    if (request.method === 'GET' && path === '/api/today') return json({ date, dayNumber: dayNumber(date, await settings.launchDate()), resetsAt: resetAt(date), name: GAME.name, member: { name: member.display_name } });
    if (request.method === 'GET' && path === '/api/state') {
      const run = await ownRun(url.searchParams.get('run'), member);
      return run ? json(await state(run)) : fail('Dive not found on this device.', 404);
    }
    if (request.method === 'GET' && path === '/api/review') {
      const run = await ownRun(url.searchParams.get('run'), member);
      if (!run?.completed) return fail('Finish your dive before opening the answer sheet.', 403);
      const own = await state(run), prompts = await promptsFor(run);
      const board = run.mode === 'daily' ? (await store.dailyBoard(run.date))
        .map(b => ({ name: b.display_name, score: b.score, tiers: b.tiers, you: b.run_id === run.id }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)) : [];
      const others = board.filter(b => !b.you);
      return json({
        prompts: prompts.map(p => ({ text: p.text, answers: p.answers.map(a => ({ answer: a.answer, tier: a.tier, score: TIERS[a.tier].score, ...(a.quip ? { quip: a.quip } : {}) })).sort((a, b) => b.score - a.score || a.answer.localeCompare(b.answer)) })),
        board, population: others.length, beat: others.filter(b => b.score < own.score).length,
      });
    }
    if (request.method !== 'POST') return fail('Unknown endpoint.', 404);

    if (path === '/api/start') {
      const mode = data.practice === true ? 'practice' : 'daily';
      const [existing, puzzle] = await Promise.all([mode === 'daily' ? store.getDailyRun(member.id, date) : null, dailyPuzzle(date)]);
      if (existing) {
        // Coming back to a dive that was left paused (menu open, then switched name or closed the tab): resume it.
        if (existing.paused_at) { await store.resume(existing.id, now()); return json(await state(await store.getRun(existing.id))); }
        return json(await state(existing));
      }
      const promptIds = mode === 'daily' ? puzzle.prompt_ids : pickPrompts(await store.enabledPrompts(), { random: cryptoRandom, exclude: new Set(puzzle.prompt_ids) });
      const run = await store.createRun({ id: crypto.randomUUID(), member_id: member.id, date, mode, prompt_ids: promptIds, round_start: now() + PREVIEW_MS, created_at: iso(now()) });
      // createRun returns the existing run if a daily one was created concurrently, so only assume no answers for a fresh run.
      return json(await state(run, run.next_round === 0 ? { answers: [] } : {}));
    }
    // The clock is read before any database work, so database latency never makes an answer late.
    const t = now();
    const loaded = await loadRun(data.runId, member);
    if (!loaded) return fail('Dive not found.', 404);
    const { run, answers } = loaded;
    if (path === '/api/pause') {
      if (data.paused === true && !run.completed && run.round_start !== null && !run.paused_at && t <= run.round_start + ROUND_MS) await store.pause(run.id, t);
      else if (data.paused === false && run.paused_at) await store.resume(run.id, t);
      return json(await state(await store.getRun(run.id), { answers }));
    }
    if (path === '/api/next') {
      if (run.paused_at) return fail('Close the menu to resume your dive.', 409);
      if (run.completed || run.round_start !== null) return json(await state(run, { answers }));
      const [started, prompts] = await Promise.all([store.startRound(run.id, t + PREVIEW_MS), promptsFor(run)]);
      return json(await state(started || await store.getRun(run.id), { answers, prompts }));
    }
    if (path === '/api/answer') {
      if (run.paused_at) return fail('Close the menu to resume your dive.', 409);
      if (run.completed || run.round_start === null || data.round !== run.next_round) return json({ state: await state(run, { answers }), alreadyScored: true });
      if (t < run.round_start) return fail('The answer window has not opened yet.', 409);
      const prompts = await promptsFor(run), prompt = prompts[run.next_round];
      const { raw, match, rejected, correction, result } = judgeAnswer(run, prompt, data, t);
      if (raw) await defer(store.logGuess({ run_id: run.id, prompt_id: prompt.id, round: run.next_round, raw, normalized: normalize(raw), matched_answer: match?.answer || null, created_at: iso(t) }));
      if (rejected) return json(rejected);
      if (correction) return json(correction);
      const scored = await store.scoreRound(run.id, result.round, { ...result, createdAt: iso(t) }, ROUNDS);
      // Normally we know exactly what changed, so no re-read. If another request scored this round
      // first (a race), re-read so the response shows what was actually recorded.
      const fresh = scored
        ? await state({ ...run, next_round: result.round + 1, round_start: null, completed: result.round + 1 >= ROUNDS }, { answers: [...answers, { round: result.round, raw_answer: result.rawAnswer, answer: result.answer, tier: result.tier, score: result.score }], prompts })
        : await state(await store.getRun(run.id), { prompts });
      const accepted = fresh.results.find(r => r.round === result.round);
      // Quip only if this request's answer is the one that was recorded.
      const quip = accepted?.answer && accepted.answer === match?.answer ? match.quip || null : null;
      return json({ result: { ...result, ...accepted, quip, promptText: prompt.text }, state: fresh });
    }
    return fail('Unknown endpoint.', 404);
  }

  // Preview dives (before the launch date): same game, nothing stored. The run is a signed token
  // the browser sends back as runId; every response carries the updated token.
  async function previewApi(request, url, session, data, launch, env) {
    const path = url.pathname, date = gameDate(now()), sid = session.tokenHash.slice(0, 16);
    const view = async (run, prompts) => ({ ...await state({ ...run, id: 'preview', mode: 'preview' }, { answers: run.results.map(r => ({ round: r.round, raw_answer: r.rawAnswer, answer: r.answer, tier: r.tier, score: r.score })), prompts: prompts || await store.promptsByIds(run.prompt_ids) }), runId: await signRun(run, env), launchDate: launch });
    if (request.method === 'GET' && path === '/api/today') return json({ date, dayNumber: 0, preview: true, launchDate: launch, resetsAt: resetAt(date), name: GAME.name, member: null });
    if (path === '/api/start' && request.method === 'POST') {
      // Random prompts, keeping the launch-day prompts out so Dive #1 isn't spoiled.
      const launchIds = await choosePuzzleIds(store, launch);
      const run = { sid, date, prompt_ids: pickPrompts(await store.enabledPrompts(), { random: cryptoRandom, exclude: new Set(launchIds) }), next_round: 0, round_start: now() + PREVIEW_MS, paused_at: null, completed: false, results: [] };
      return json(await view(run));
    }
    const token = request.method === 'GET' ? url.searchParams.get('run') : data.runId;
    const run = await readRun(token, env, sid);
    if (!run || run.date !== date) return fail('Dive not found.', 404);
    const t = now();
    if (request.method === 'GET' && path === '/api/state') return json(await view(run));
    if (request.method === 'GET' && path === '/api/review') {
      if (!run.completed) return fail('Finish your dive before opening the answer sheet.', 403);
      const prompts = await store.promptsByIds(run.prompt_ids);
      return json({ prompts: prompts.map(p => ({ text: p.text, answers: p.answers.map(a => ({ answer: a.answer, tier: a.tier, score: TIERS[a.tier].score, ...(a.quip ? { quip: a.quip } : {}) })).sort((a, b) => b.score - a.score || a.answer.localeCompare(b.answer)) })), board: [], population: 0, beat: 0, preview: true });
    }
    if (request.method !== 'POST') return fail('Unknown endpoint.', 404);
    if (path === '/api/pause') {
      if (data.paused === true && !run.completed && run.round_start !== null && !run.paused_at && t <= run.round_start + ROUND_MS) run.paused_at = t;
      else if (data.paused === false && run.paused_at) { run.round_start += t - run.paused_at; run.paused_at = null; }
      return json(await view(run));
    }
    if (path === '/api/next') {
      if (run.paused_at) return fail('Close the menu to resume your dive.', 409);
      if (!run.completed && run.round_start === null) run.round_start = t + PREVIEW_MS;
      return json(await view(run));
    }
    if (path === '/api/answer') {
      if (run.paused_at) return fail('Close the menu to resume your dive.', 409);
      if (run.completed || run.round_start === null || data.round !== run.next_round) return json({ state: await view(run), alreadyScored: true });
      if (t < run.round_start) return fail('The answer window has not opened yet.', 409);
      const prompts = await store.promptsByIds(run.prompt_ids), prompt = prompts[run.next_round];
      const { match, rejected, correction, result } = judgeAnswer(run, prompt, data, t);
      if (rejected) return json(rejected);
      if (correction) return json(correction);
      run.results.push(result);
      run.next_round += 1; run.round_start = null; run.completed = run.next_round >= ROUNDS;
      return json({ result: { ...result, quip: match?.quip || null, promptText: prompt.text }, state: await view(run, prompts) });
    }
    return fail('Unknown endpoint.', 404);
  }

  // All /api/* requests: Origin + body checks, login, session, CSRF, then names and game routes.
  async function api(request, url, env, defer) {
    const path = url.pathname, post = request.method === 'POST';
    if (!['GET', 'POST'].includes(request.method)) return fail('Method not allowed.', 405);
    let data = {};
    if (post) {
      // Every request that changes data must come from this site.
      if (request.headers.get('Origin') !== url.origin) return fail('Cross-origin requests are not accepted.', 403);
      const body = await readJson(request, MAX_BODY);
      if (body.error) return body.error;
      data = body.data ?? null;
      if (path === '/api/login') return login(request, url, env, data && typeof data === 'object' ? data.password : undefined); // malformed bodies get the same "Wrong password"
      if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('Invalid request.');
    }

    const session = await playerSession(request, url, env);
    const launch = session ? await settings.launchDate() : null, preview = !!launch && gameDate(now()) < launch;
    if (request.method === 'GET' && path === '/api/session') {
      if (!session) return json({ authenticated: false });
      return json({ authenticated: true, csrf: await csrfFor(session.token, 'player'), member: session.member && { id: session.member.id, name: session.member.display_name }, preview: preview ? { launchDate: launch } : null });
    }
    if (!session) return fail('Members only.', 401);
    if (post && !timingSafeEqual(request.headers.get('X-CSRF-Token') || '', await csrfFor(session.token, 'player'))) return fail('Invalid request.', 403);
    if (now() - Date.parse(session.row.last_seen) > LAST_SEEN_EVERY_MS) {
      session.row.last_seen = iso(now());
      await defer(store.updateSession('player', session.tokenHash, { last_seen: session.row.last_seen }));
    }

    if (post && path === '/api/logout') {
      await store.updateSession('player', session.tokenHash, { revoked: true });
      forgetSession(session.tokenHash);
      return json({ ok: true }, 200, { 'Set-Cookie': playerCookie(url, '', 0) });
    }
    if (request.method === 'GET' && path === '/api/members') {
      return json({ members: (await store.activeMembers()).map(m => ({ id: m.id, name: m.display_name })) });
    }
    if (post && path === '/api/add-member') {
      // "Name not here?": the admin password adds the name, then this device picks it.
      const r = await admin.addMemberFromPicker(request, env, data);
      if (r.response) return r.response;
      await store.updateSession('player', session.tokenHash, { member_id: r.member.id });
      forgetSession(session.tokenHash);
      return json({ member: { id: r.member.id, name: r.member.display_name } });
    }
    if (post && path === '/api/member') {
      // Trust-based: anyone with the password may pick any active name. One daily dive per member still applies.
      let member = null;
      if (data.memberId !== null) {
        const found = UUID.test(data.memberId || '') ? await store.member(data.memberId) : null;
        if (!found?.active) return fail('Pick a name from the list.', 400);
        member = { id: found.id, display_name: found.display_name };
      }
      await store.updateSession('player', session.tokenHash, { member_id: member?.id ?? null });
      forgetSession(session.tokenHash);
      return json({ member: member && { id: member.id, name: member.display_name } });
    }
    // Before the launch date: preview dives, no name needed, nothing stored.
    if (preview) return previewApi(request, url, session, data, launch, env);
    if (!session.member) return fail('Pick your name first.', 409, { needMember: true });
    return gameApi(request, url, session.member, data, defer);
  }

  const admin = createAdminApi({ store, now, settings });
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      try {
        if (url.pathname.startsWith('/api/admin/')) return securityHeaders(await admin.handle(request, url, env), { 'Cache-Control': 'no-store' });
        if (url.pathname.startsWith('/api/')) {
          // In the Worker, ctx.waitUntil finishes background writes after responding; without ctx (tests) they're awaited.
          const defer = ctx?.waitUntil ? promise => { ctx.waitUntil(promise.catch(e => console.error('Background write failed:', e.message))); } : promise => promise;
          return securityHeaders(await api(request, url, env, defer), { 'Cache-Control': 'no-store' });
        }
        if (!['GET', 'HEAD'].includes(request.method)) return securityHeaders(fail('Method not allowed.', 405));
        // The admin page is public HTML/JS; no prompt or answer data loads without an admin session.
        if (url.pathname === '/admin') return securityHeaders(new Response(request.method === 'HEAD' ? null : adminPage(env, { signedIn: await admin.hasSession(request, url, env) }), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }));
        if (url.pathname === '/' || url.pathname === '/index.html') {
          // No session: only the password screen (game name and art; no prompts, scores or names).
          const page = await playerSession(request, url, env) ? gamePage(env) : loginPage(env);
          return securityHeaders(new Response(request.method === 'HEAD' ? null : page, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }));
        }
        const asset = await env.ASSETS.fetch(request);
        return securityHeaders(asset, asset.ok ? { 'Cache-Control': url.pathname.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache' } : {});
      } catch (e) {
        console.error('Request failed:', e.message);
        return securityHeaders(fail('The signal is temporarily lost. Please retry.', 503), { 'Cache-Control': 'no-store' });
      }
    },
  };
}
