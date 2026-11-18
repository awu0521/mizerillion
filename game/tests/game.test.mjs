// Milestone 1 tests: matching, scoring, server clock, one daily run, puzzle rules, no answer leaks.
// Uses only the FAKE bank in fixtures/sample_bank.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/worker.mjs';
import { MemoryStore } from '../src/store/memory.mjs';
import { pickPrompts, seededRandom, isSpecial } from '../src/puzzle.mjs';
import { normalize, distance, matchAnswer, gameDate, resetAt, shareText, TIERS, ROUND_MS, PREVIEW_MS, GRACE_MS } from '../public/rules.mjs';

const BANK = JSON.parse(readFileSync(new URL('../fixtures/sample_bank.json', import.meta.url), 'utf8'));
const answersOf = id => BANK.prompts.find(p => p.id === id).answers;
const START = Date.parse('2026-11-20T18:00:00Z'); // 10:00 in Vancouver

// A test harness: one Worker app, a fake clock, and per-player cookie jars.
function harness() {
  const store = new MemoryStore({ bank: BANK }), clock = { t: START };
  const app = createApp({ store, now: () => clock.t });
  const env = { ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };
  function player() {
    let cookie = '';
    return {
      async call(path, data, headers = {}) {
        const init = data === undefined ? { headers: { Cookie: cookie, ...headers } } : { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers } };
        const r = await app.fetch(new Request('http://localhost:8787' + path, init), env);
        const set = r.headers.get('Set-Cookie'); if (set) cookie = set.split(';')[0];
        const text = await r.text();
        return { status: r.status, body: JSON.parse(text), text };
      },
    };
  }
  return { store, clock, player };
}
// Answer for the run's current round, found from the store (the test knows the bank; the client doesn't).
async function answerFor(store, runId, tier) {
  const run = await store.getRun(runId), [p] = await store.promptsByIds([run.prompt_ids[run.next_round]]);
  return p.answers.find(a => a.tier === tier) || p.answers[0];
}
async function playAll(h, p, tierFor = () => 'krillion') {
  let { body: game } = await p.call('/api/start', {});
  for (let i = 0; i < 7; i++) {
    h.clock.t += PREVIEW_MS + 1000;
    const a = await answerFor(h.store, game.runId, tierFor(i));
    const r = await p.call('/api/answer', { runId: game.runId, round: i, answer: a.answer, confirm: true });
    game = r.body.state;
    if (i < 6) game = (await p.call('/api/next', { runId: game.runId })).body;
  }
  return game;
}

test('normalize keeps emoji and matches make_prompts.py', () => {
  assert.equal(normalize('❤️'), '❤');
  assert.equal(normalize('Roy’s Dark Desires!'), 'roysdarkdesires');
  assert.equal(normalize('🏳️‍🌈'), '🏳🌈');
  assert.equal(normalize('Café & Bar'), 'cafeandbar');
  assert.equal(normalize('  LMAO '), 'lmao');
  assert.equal(normalize('Reykjavík'), 'reykjavik');
  assert.equal(normalize('^_^ ~'), ''); // ASCII symbols (below U+2000) are dropped
});
test('lengths and edit distance count code points, not UTF-16 units', () => {
  assert.equal(Array.from(normalize('🦭')).length, 1);
  assert.equal(distance('🦭', '💀'), 1);
  assert.equal(distance('kitten', 'sitting'), 3);
});
test('answer matching: aliases, emoji, typo corrections, no fuzzy emoji', () => {
  const emoji = answersOf('likes-emoji');
  assert.equal(matchAnswer('seal', emoji).answer, '🦭');
  assert.equal(matchAnswer('🦭', emoji).correction, false);
  assert.equal(matchAnswer('❤️', emoji).answer, '❤');
  assert.equal(matchAnswer('🏳️‍🌈', emoji).tier, 'krillion');
  assert.equal(matchAnswer('🐙', emoji), null, 'a single emoji gets zero typo allowance');
  const shows = answersOf('media-shows');
  assert.equal(matchAnswer("roys dark desires", shows).correction, false);
  const typo = matchAnswer('Bake Of', shows); assert.equal(typo.answer, 'Bake Off'); assert.equal(typo.correction, true);
  assert.equal(matchAnswer('zzzzzzzz', shows), null);
  assert.equal(matchAnswer('', shows), null);
  assert.equal(matchAnswer('Cafe and Bar Lumiere', answersOf('places-hangouts')).answer, 'Café & Bar Lumière');
});
test('the day resets at midnight in Vancouver, across DST', () => {
  assert.equal(gameDate(Date.parse('2026-11-20T07:59:59Z')), '2026-11-19');
  assert.equal(gameDate(Date.parse('2026-11-20T08:00:00Z')), '2026-11-20');
  assert.equal(new Date(resetAt('2026-11-20')).toISOString(), '2026-11-21T08:00:00.000Z'); // PST
  assert.equal(new Date(resetAt('2026-07-01')).toISOString(), '2026-07-02T07:00:00.000Z'); // PDT
  assert.equal(new Date(resetAt('2026-03-07')).toISOString(), '2026-03-08T08:00:00.000Z'); // DST starts at 2am on the 8th
});
test('share text', () => {
  const results = [{ tier: 'krillion', score: 100 }, { tier: null, score: 0 }, { tier: 'plankton', score: 10 }];
  assert.equal(shareText(5, results), 'Mizerillion #5 🦐\n110/700 · 1100m\n🌟⬛🫧');
});

test('puzzle selection: 7 distinct enabled prompts, category and nicknames/words caps, deterministic', () => {
  const store = new MemoryStore({ bank: BANK });
  return store.enabledPrompts().then(enabled => {
    assert.ok(!enabled.some(p => p.id === 'likes-most-liked'), 'review: true prompts start disabled');
    for (let d = 0; d < 50; d++) {
      const ids = pickPrompts(enabled, { random: seededRandom('2026-12-' + d) });
      assert.equal(new Set(ids).size, 7);
      const cats = {}; for (const id of ids) { const c = enabled.find(p => p.id === id).category; cats[c] = (cats[c] || 0) + 1; }
      assert.ok(Object.values(cats).every(n => n <= 2), JSON.stringify(cats));
      assert.ok(ids.filter(isSpecial).length <= 1);
    }
    assert.deepEqual(pickPrompts(enabled, { random: seededRandom('2026-11-20') }), pickPrompts(enabled, { random: seededRandom('2026-11-20') }));
  });
});
test('puzzle selection avoids recent prompts while enough remain, then reuses the oldest', () => {
  const prompts = Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, category: 'c' + (i % 10) }));
  const lastUsed = new Map(prompts.slice(0, 13).map((p, i) => [p.id, '2026-11-' + String(10 + i).padStart(2, '0')]));
  const ids = pickPrompts(prompts, { random: seededRandom('x'), lastUsed });
  assert.deepEqual(ids.filter(id => !lastUsed.has(id)).sort(), prompts.slice(13).map(p => p.id).sort(), 'all 7 fresh prompts are used');
  const lastUsed2 = new Map(prompts.slice(0, 16).map((p, i) => [p.id, '2026-11-' + String(10 + i).padStart(2, '0')]));
  const ids2 = pickPrompts(prompts, { random: seededRandom('y'), lastUsed: lastUsed2 });
  assert.ok(['p16', 'p17', 'p18', 'p19'].every(id => ids2.includes(id)));
  assert.deepEqual(ids2.filter(id => lastUsed2.has(id)).sort(), ['p0', 'p1', 'p2'], 'the oldest recent prompts are reused first');
});
test('the daily puzzle is stored on first open and never changes; the next day avoids it', async () => {
  const h = harness(), a = h.player(), b = h.player();
  const ga = (await a.call('/api/start', {})).body, gb = (await b.call('/api/start', {})).body;
  const first = await h.store.getPuzzle('2026-11-20');
  assert.equal(first.prompt_ids.length, 7);
  assert.deepEqual((await h.store.getRun(ga.runId)).prompt_ids, first.prompt_ids);
  assert.deepEqual((await h.store.getRun(gb.runId)).prompt_ids, first.prompt_ids);
  h.clock.t += 86400000;
  await a.call('/api/start', {});
  const second = await h.store.getPuzzle('2026-11-21');
  // 12 enabled prompts but only 9 can satisfy the caps, so overlap is possible; it must be minimal.
  assert.ok(second.prompt_ids.filter(id => first.prompt_ids.includes(id)).length <= 3);
});

test('seven rounds are scored on the server; client scores and retries are ignored', async () => {
  const h = harness(), p = h.player();
  let { body: game } = await p.call('/api/start', {});
  assert.equal(game.prompts.filter(Boolean).length, 1, 'only the current prompt is sent');
  for (let i = 0; i < 7; i++) {
    h.clock.t += PREVIEW_MS + 500;
    const a = await answerFor(h.store, game.runId, 'krillion');
    const r = await p.call('/api/answer', { runId: game.runId, round: i, answer: a.answer, confirm: true, score: 99999, tier: 'krillion' });
    assert.equal(r.status, 200); assert.equal(r.body.result.score, TIERS.krillion.score);
    const dup = await p.call('/api/answer', { runId: game.runId, round: i, answer: a.answer, confirm: true });
    assert.equal(dup.body.alreadyScored, true); assert.equal(dup.body.state.results.length, i + 1);
    game = r.body.state;
    if (i < 6) { game = (await p.call('/api/next', { runId: game.runId })).body; assert.equal(game.round, i + 1); }
  }
  assert.equal(game.score, 700); assert.equal(game.completed, true);
});
test('wrong guesses cost nothing; typo asks to confirm; every guess is logged', async () => {
  const h = harness(), p = h.player();
  const { body: game } = await p.call('/api/start', {});
  h.clock.t += PREVIEW_MS + 100;
  const rej = await p.call('/api/answer', { runId: game.runId, round: 0, answer: 'qqqqqqqqqq' });
  assert.equal(rej.body.rejected, true); assert.match(rej.body.message, /no echo/);
  const target = await answerFor(h.store, game.runId, 'plankton');
  const typo = target.answer.length >= 4 ? target.answer.slice(0, -1) + (target.answer.endsWith('x') ? 'y' : 'x') : null;
  if (typo) {
    const c = await p.call('/api/answer', { runId: game.runId, round: 0, answer: typo });
    if (c.body.correction) assert.equal(c.body.correction, target.answer);
  }
  const ok = await p.call('/api/answer', { runId: game.runId, round: 0, answer: target.answer, confirm: true });
  assert.ok(ok.body.result.score > 0);
  assert.ok(h.store.guesses.length >= 2);
  assert.equal(h.store.guesses[0].raw, 'qqqqqqqqqq'); assert.equal(h.store.guesses[0].matched_answer, null);
  assert.equal(h.store.guesses.at(-1).matched_answer, target.answer);
});
test('round deadline: closed before the preview ends, grace only for timed submits, no reopening', async () => {
  const h = harness(), p = h.player();
  let { body: game } = await p.call('/api/start', {});
  const a0 = await answerFor(h.store, game.runId, 'krillion');
  assert.equal((await p.call('/api/answer', { runId: game.runId, round: 0, answer: a0.answer })).status, 409, 'not open during preview');
  // A manual answer 1 ms late is a miss, even within the grace window.
  h.clock.t = game.roundStart + ROUND_MS + 1;
  let r = await p.call('/api/answer', { runId: game.runId, round: 0, answer: a0.answer, confirm: true });
  assert.equal(r.body.result.score, 0);
  // It can't be reopened.
  r = await p.call('/api/answer', { runId: game.runId, round: 0, answer: a0.answer, confirm: true });
  assert.equal(r.body.alreadyScored, true); assert.equal(r.body.state.score, 0);
  // Round 2: the client's own timeout submit inside the grace window counts.
  game = (await p.call('/api/next', { runId: game.runId })).body;
  const a1 = await answerFor(h.store, game.runId, 'krillion');
  h.clock.t = game.roundStart + ROUND_MS + GRACE_MS - 10;
  r = await p.call('/api/answer', { runId: game.runId, round: 1, answer: a1.answer, timeout: true });
  assert.equal(r.body.result.score, 100);
  // Round 3: a timeout submit past the grace window is a miss.
  game = (await p.call('/api/next', { runId: game.runId })).body;
  const a2 = await answerFor(h.store, game.runId, 'krillion');
  h.clock.t = game.roundStart + ROUND_MS + GRACE_MS + 10;
  r = await p.call('/api/answer', { runId: game.runId, round: 2, answer: a2.answer, timeout: true });
  assert.equal(r.body.result.score, 0);
});
test('one daily dive per member per day; practice is separate and stays off the board', async () => {
  const h = harness(), p = h.player(), q = h.player();
  const first = (await p.call('/api/start', {})).body, again = (await p.call('/api/start', {})).body;
  assert.equal(first.runId, again.runId);
  const practice = (await p.call('/api/start', { practice: true })).body;
  assert.notEqual(practice.runId, first.runId); assert.equal(practice.mode, 'practice');
  const daily = await h.store.getPuzzle('2026-11-20');
  const pIds = (await h.store.getRun(practice.runId)).prompt_ids;
  assert.equal(pIds.length, 7);
  // Only 5 enabled prompts are outside today's daily, so practice must use all of them that the caps allow.
  const others = (await h.store.enabledPrompts()).filter(x => !daily.prompt_ids.includes(x.id));
  const usedOthers = others.filter(x => pIds.includes(x.id));
  assert.ok(usedOthers.length >= others.filter(x => !isSpecial(x.id)).length - 2, 'practice prefers prompts outside today’s daily');
  // Another member can't read or play this member's run.
  assert.equal((await q.call('/api/state?run=' + first.runId)).status, 404);
  assert.equal((await q.call('/api/answer', { runId: first.runId, round: 0, answer: 'x' })).status, 404);
});
test('answers stay hidden until the dive is complete; the review then shows the board', async () => {
  const h = harness(), p = h.player(), q = h.player();
  const { body: game } = await p.call('/api/start', {});
  const run = await h.store.getRun(game.runId), prompts = await h.store.promptsByIds(run.prompt_ids);
  const st = await p.call('/api/state?run=' + game.runId);
  for (const pr of prompts) for (const a of pr.answers.filter(a => a.answer.length > 3)) assert.ok(!st.text.includes(a.answer), 'state leaks ' + a.answer);
  assert.ok(!st.text.includes(prompts[1].text), 'future prompt text is not sent');
  assert.equal((await p.call('/api/review?run=' + game.runId)).status, 403);
  assert.ok(!(await p.call('/api/today')).text.includes(prompts[0].text));
  // Finish both dives, then compare.
  await playAll(h, p, () => 'krillion');
  await playAll(h, q, () => 'plankton');
  const rev = await p.call('/api/review?run=' + game.runId);
  assert.equal(rev.status, 200); assert.equal(rev.body.prompts.length, 7);
  assert.ok(rev.body.prompts.every(x => x.answers.length >= 5 && x.answers.every(a => a.tier && 'score' in a)));
  assert.equal(rev.body.population, 1); assert.equal(rev.body.beat, 1);
  assert.equal(rev.body.board[0].you, true); assert.equal(rev.body.board[0].score, 700);
  assert.ok(!rev.text.includes('weight'), 'weights are not sent');
});
test('the public bundle contains no fixture prompt or answer text', () => {
  const files = [], walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(new URL('../public', import.meta.url).pathname);
  const text = files.filter(f => /\.(mjs|js|css|html|json|svg|txt)$/.test(f)).map(f => readFileSync(f, 'utf8')).join('\n');
  for (const needle of ['Zorblax', 'Quinterfield', 'Captain Spreadsheet', 'Sergeant Pickles', 'Name a name this group chat has had']) assert.ok(!text.includes(needle), needle);
});
