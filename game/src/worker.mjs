// Mizerillion Worker. Game flow ported from OpenKrillion's src/worker.mjs (MIT):
// the server owns the clock, the score and the answer sheet.
import { GAME } from '../public/site.mjs';
import { TIERS, ROUND_MS, PREVIEW_MS, GRACE_MS, ROUNDS, normalize, matchAnswer, gameDate, resetAt, dayNumber } from '../public/rules.mjs';
import { pickPrompts, seededRandom, cryptoRandom, RECENT_DAYS } from './puzzle.mjs';
import { gamePage } from './html.mjs';

const MAX_BODY = 8000;
const json = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
const fail = (message, status = 400) => json({ error: message }, status);
const UUID = /^[a-f0-9-]{36}$/;
const addDays = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function securityHeaders(response, extra = {}) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'X-Frame-Options': 'DENY', ...extra })) h.set(k, v);
  return new Response(response.body, { status: response.status, headers: h });
}

// Milestone 1 identity: an anonymous per-browser id, like OpenKrillion's ok_player cookie.
// Milestone 3 replaces this with the shared player password + pick-your-name session.
export async function devIdentity(request, store) {
  let id = request.headers.get('Cookie')?.match(/(?:^|;\s*)mz_dev=([a-f0-9-]{36})/)?.[1], setCookie = null;
  if (!id) { id = crypto.randomUUID(); setCookie = `mz_dev=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`; }
  const member = await store.ensureMember(id, 'Diver ' + id.slice(0, 4).toUpperCase());
  return { member, setCookie };
}

export function createApp({ store, now = () => Date.now(), identify = devIdentity }) {
  async function dailyPuzzle(date) {
    const existing = await store.getPuzzle(date);
    if (existing) return existing;
    const recent = await store.puzzlesBetween(addDays(date, -RECENT_DAYS), date);
    const lastUsed = new Map();
    for (const p of recent.sort((a, b) => a.date.localeCompare(b.date))) for (const id of p.prompt_ids) lastUsed.set(id, p.date);
    const ids = pickPrompts(await store.enabledPrompts(), { random: seededRandom(date), lastUsed });
    return store.createPuzzle({ date, day_number: dayNumber(date), prompt_ids: ids });
  }
  async function practiceIds(date) {
    const today = await dailyPuzzle(date); // keep today's daily prompts out of practice while possible
    return pickPrompts(await store.enabledPrompts(), { random: cryptoRandom, exclude: new Set(today.prompt_ids) });
  }
  async function promptsFor(run) { return store.promptsByIds(run.prompt_ids); }

  // What the browser may see: prompt text only up to the current round, never answers.
  async function state(run) {
    const answers = await store.answersFor(run.id), prompts = await promptsFor(run);
    const visible = run.completed ? ROUNDS : run.next_round + 1;
    return {
      date: run.date, dayNumber: dayNumber(run.date), resetsAt: resetAt(run.date),
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

  async function api(request, url, member) {
    const path = url.pathname, date = gameDate(now());
    if (request.method === 'GET' && path === '/api/today') return json({ date, dayNumber: dayNumber(date), resetsAt: resetAt(date), name: GAME.name, member: { name: member.display_name } });
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
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return fail('Cross-origin requests are not accepted.', 403);
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return fail('Request is too large.', 413);
    let data;
    try { const raw = await request.text(); if (raw.length > MAX_BODY) return fail('Request is too large.', 413); data = JSON.parse(raw); } catch { return fail('Invalid request.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('Invalid request.');

    if (path === '/api/start') {
      const mode = data.practice === true ? 'practice' : 'daily';
      let run = mode === 'daily' ? await store.getDailyRun(member.id, date) : null;
      if (!run) {
        const promptIds = mode === 'daily' ? (await dailyPuzzle(date)).prompt_ids : await practiceIds(date);
        run = await store.createRun({ id: crypto.randomUUID(), member_id: member.id, date, mode, prompt_ids: promptIds, round_start: now() + PREVIEW_MS, created_at: new Date(now()).toISOString() });
      }
      return json(await state(run));
    }
    const run = await ownRun(data.runId, member);
    if (!run) return fail('Dive not found.', 404);
    if (path === '/api/pause') {
      const t = now();
      if (data.paused === true && !run.completed && run.round_start !== null && !run.paused_at && t <= run.round_start + ROUND_MS) await store.pause(run.id, t);
      else if (data.paused === false && run.paused_at) await store.resume(run.id, t);
      return json(await state(await store.getRun(run.id)));
    }
    if (path === '/api/next') {
      if (run.paused_at) return fail('Close the menu to resume your dive.', 409);
      if (!run.completed && run.round_start === null) await store.startRound(run.id, now() + PREVIEW_MS);
      return json(await state(await store.getRun(run.id)));
    }
    if (path === '/api/answer') {
      if (run.paused_at) return fail('Close the menu to resume your dive.', 409);
      if (run.completed || run.round_start === null || data.round !== run.next_round) return json({ state: await state(run), alreadyScored: true });
      const t = now();
      if (t < run.round_start) return fail('The answer window has not opened yet.', 409);
      const [prompt] = await store.promptsByIds([run.prompt_ids[run.next_round]]);
      const raw = typeof data.answer === 'string' ? data.answer.trim().slice(0, 256) : '';
      const late = t > run.round_start + ROUND_MS;
      // The grace period covers only the client's own timed submission; a late manual request
      // can't revive an expired round (it is scored as a miss).
      const timely = !late || (data.timeout === true && t <= run.round_start + ROUND_MS + GRACE_MS);
      const match = raw && timely ? matchAnswer(raw, prompt.answers) : null;
      if (raw) await store.logGuess({ run_id: run.id, prompt_id: prompt.id, round: run.next_round, raw, normalized: normalize(raw), matched_answer: match?.answer || null, created_at: new Date(t).toISOString() });
      if (!match && raw && !late && !data.timeout) return json({ rejected: true, message: `“${raw}”: no echo. try again` });
      if (match?.correction && data.confirm !== true && !late && !data.timeout && data.previewCorrection !== false) return json({ correction: match.answer, original: raw });
      const result = { round: run.next_round, rawAnswer: raw || null, answer: match?.answer || null, tier: match?.tier || null, score: match ? TIERS[match.tier].score : 0 };
      await store.scoreRound(run.id, result.round, { ...result, createdAt: new Date(t).toISOString() }, ROUNDS);
      const fresh = await state(await store.getRun(run.id));
      const accepted = fresh.results.find(r => r.round === result.round);
      // Quip only if this request's answer is the one that was recorded.
      const quip = accepted?.answer && accepted.answer === match?.answer ? match.quip || null : null;
      return json({ result: { ...result, ...accepted, quip, promptText: prompt.text }, state: fresh });
    }
    return fail('Unknown endpoint.', 404);
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      try {
        if (url.pathname.startsWith('/api/')) {
          const { member, setCookie } = await identify(request, store);
          const response = await api(request, url, member);
          if (setCookie) response.headers.append('Set-Cookie', setCookie + (url.protocol === 'https:' ? '; Secure' : ''));
          return securityHeaders(response);
        }
        if (!['GET', 'HEAD'].includes(request.method)) return securityHeaders(fail('Method not allowed.', 405));
        if (url.pathname === '/' || url.pathname === '/index.html') return securityHeaders(new Response(request.method === 'HEAD' ? null : gamePage(env), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }));
        const asset = await env.ASSETS.fetch(request);
        return securityHeaders(asset, asset.ok ? { 'Cache-Control': url.pathname.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache' } : {});
      } catch (e) {
        console.error('Request failed:', e.message);
        return securityHeaders(fail('The signal is temporarily lost. Please retry.', 503));
      }
    },
  };
}
