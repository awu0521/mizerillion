// Pure rules: normalize/match, Vancouver clock, share text, puzzle selection, public bundle.
// Uses only the FAKE bank in fixtures/sample_bank.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.mjs';
import { pickPrompts, seededRandom, isSpecial } from '../src/puzzle.mjs';
import { normalize, distance, matchAnswer, gameDate, resetAt, shareText } from '../public/rules.mjs';

const BANK = JSON.parse(readFileSync(new URL('../fixtures/sample_bank.json', import.meta.url), 'utf8'));
const answersOf = id => BANK.prompts.find(p => p.id === id).answers;

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
  const stretched = matchAnswer('Baaaaaake Offffff', shows); assert.equal(stretched.answer, 'Bake Off'); assert.equal(stretched.correction, true);
  const twins = [{ answer: 'lol', tier: 'plankton' }, { answer: 'lool', tier: 'rare' }];
  assert.equal(matchAnswer('loooool', twins), null, 'stretching must not pick between two answers that squeeze the same');
  assert.equal(matchAnswer('lool', twins).answer, 'lool', 'an exact match still wins');
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
test('the public bundle contains no fixture prompt or answer text', () => {
  const files = [], walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(new URL('../public', import.meta.url).pathname);
  const text = files.filter(f => /\.(mjs|js|css|html|json|svg|txt)$/.test(f)).map(f => readFileSync(f, 'utf8')).join('\n');
  for (const needle of ['Zorblax', 'Quinterfield', 'Captain Spreadsheet', 'Sergeant Pickles', 'Name a name this group chat has had']) assert.ok(!text.includes(needle), needle);
});

test('the production config bundles no bank, no fake names, and no local test mode', () => {
  const jsonc = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const config = JSON.parse(jsonc);
  assert.equal(config.vars?.LOCAL_DEVELOPMENT, undefined);
  assert.equal(config.vars?.STORE, undefined, 'production uses Supabase');
  assert.equal(config.alias['prompt-bank'], './src/empty_bank.json');
  assert.equal(config.alias['fake-members'], './src/empty_members.json');
  assert.deepEqual(JSON.parse(readFileSync(new URL('../src/empty_bank.json', import.meta.url), 'utf8')).prompts, []);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../src/empty_members.json', import.meta.url), 'utf8')), []);
  for (const secret of ['SUPABASE_SERVICE_ROLE_KEY', 'PLAYER_PASSWORD_HASH', 'ADMIN_PASSWORD_HASH']) assert.ok(!(secret in (config.vars || {})), secret + ' must be a secret, not a var');
});
