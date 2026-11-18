// Checks the REAL prompt bank (git-ignored) when it exists on this machine; skipped otherwise.
// The bank is read at run time and never copied into this repo. Failure messages name prompts by id
// and answers by position (#n), never by their text.
//
//   npm test                                   # includes these checks if the bank exists
//   TEST_BANK=path/to/bank.json npm test       # check a different bank file
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { harness } from './helpers/app.mjs';
import { pickPrompts, seededRandom, isSpecial, MAX_PER_CATEGORY, MAX_SPECIAL } from '../src/puzzle.mjs';
import { validateBank, planSeed } from '../scripts/lib/seed_plan.mjs';
import { normalize, matchAnswer, TIERS, PREVIEW_MS } from '../public/rules.mjs';

const PATH = process.env.TEST_BANK || fileURLToPath(new URL('../../bank_generation/data/prompt_bank.json', import.meta.url));
const skip = existsSync(PATH) ? false : `no prompt bank at ${PATH}`;
const BANK = skip ? { prompts: [] } : JSON.parse(readFileSync(PATH, 'utf8'));
const enabled = () => planSeed(BANK, []).inserts.filter(r => r.enabled);
const index = (p, a) => p.answers.indexOf(a);

test('real bank: valid for seeding', { skip }, () => {
  const { errors, warnings } = validateBank(BANK);
  assert.equal(errors.length, 0, errors.join('\n').replace(/answer "[^"]*"/g, 'an answer'));
  if (warnings.length) console.log(`  note: ${warnings.length} answer(s) can't be typed: ${warnings.map(w => w.match(/\(([^)]+)\)/)?.[1]).join(', ')}`);
  // Answers that appear word-for-word in their own question can be copied straight off the screen.
  const copyable = BANK.prompts.flatMap(p => p.answers.map((a, i) => ({ p, a, i }))).filter(({ p, a }) => Array.from(a.answer).length >= 4 && p.text.includes(a.answer));
  if (copyable.length) console.log(`  note: answer(s) that appear in their own question (anyone can copy them): ${copyable.map(({ p, i }) => `${p.id} #${i + 1}`).join(', ')}`);
});

test('real bank: every answer and alias matches its own answer, never another one', { skip }, () => {
  const problems = [];
  for (const p of BANK.prompts) for (const a of p.answers) {
    for (const [kind, typed] of [['answer', a.answer], ...(a.aliases || []).map((x, i) => [`alias ${i + 1}`, x])]) {
      if (!normalize(typed)) continue; // untypeable; reported by the validity test
      const m = matchAnswer(typed, p.answers);
      if (!m) problems.push(`${p.id} #${index(p, a) + 1} ${kind}: no match`);
      else if (m.answer !== a.answer) problems.push(`${p.id} #${index(p, a) + 1} ${kind}: matches #${p.answers.findIndex(x => x.answer === m.answer) + 1} instead`);
    }
  }
  assert.deepEqual(problems, []);
});

test('real bank: enough enabled prompts for 60 days of puzzles within the selection rules', { skip }, () => {
  const prompts = enabled();
  assert.ok(prompts.length >= 7, `only ${prompts.length} enabled prompts`);
  const lastUsed = new Map();
  for (let d = 0; d < 60; d++) {
    const date = new Date(Date.UTC(2026, 10, 18 + d)).toISOString().slice(0, 10);
    const ids = pickPrompts(prompts, { random: seededRandom(date), lastUsed });
    assert.equal(new Set(ids).size, 7, date);
    const cats = {}; for (const id of ids) { const c = prompts.find(p => p.id === id).category; cats[c] = (cats[c] || 0) + 1; }
    assert.ok(Object.values(cats).every(n => n <= MAX_PER_CATEGORY), `${date}: ${JSON.stringify(cats)}`);
    assert.ok(ids.filter(isSpecial).length <= MAX_SPECIAL, `${date}: too many nicknames-/words- prompts`);
    for (const id of ids) lastUsed.set(id, date);
  }
});

test('real bank: a full daily dive and a practice dive play through on the server', { skip }, async () => {
  const h = await harness('memory', { bank: BANK }), store = h.store, clock = h.clock, player = await h.player();
  const call = (path, data) => player.call(path, data);
  for (const practice of [false, true]) {
    let game = JSON.parse((await call('/api/start', { practice })).text), expected = 0;
    for (let i = 0; i < 7; i++) {
      clock.t += PREVIEW_MS + 1000;
      const run = await store.getRun(game.runId), [p] = await store.promptsByIds([run.prompt_ids[i]]);
      const target = p.answers.find(a => a.tier === 'krillion' && normalize(a.answer)) || p.answers.find(a => normalize(a.answer));
      // Nothing from this prompt's answer list is sent before it's scored. Earlier rounds' results and
      // prompt texts are left out of the search: names legitimately repeat across prompts.
      const st = JSON.parse((await call('/api/state?run=' + game.runId)).text);
      assert.ok(st.prompts.slice(i + 1).every(x => x === null), `${p.id}: a future prompt was sent`);
      // Only text values are searched: field names like "completed" and values like "practice" are
      // ordinary words that can also be answers.
      const texts = []; (function collect(v, key) { if (typeof v === 'string' && key !== 'mode') texts.push(v); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collect(x, k); })({ ...st, results: [], prompts: st.prompts.slice(i) });
      const fresh = texts.join('\n');
      // (Answers that are part of the question itself are shown by design; the validity test lists them.)
      const leaked = p.answers.findIndex(a => Array.from(a.answer).length >= 4 && !p.text.includes(a.answer) && fresh.includes(a.answer));
      assert.equal(leaked, -1, `${p.id}: answer #${leaked + 1} was sent before it was scored`);
      const r = JSON.parse((await call('/api/answer', { runId: game.runId, round: i, answer: target.answer, confirm: true })).text);
      assert.equal(r.result.answer, target.answer, `${p.id}: #${index(p, target) + 1} did not score as itself`);
      expected += TIERS[target.tier].score;
      game = r.state;
      if (i < 6) game = JSON.parse((await call('/api/next', { runId: game.runId })).text);
    }
    assert.equal(game.completed, true); assert.equal(game.score, expected);
    const review = JSON.parse((await call('/api/review?run=' + game.runId)).text);
    assert.equal(review.prompts.length, 7);
  }
});
