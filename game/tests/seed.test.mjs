// seed_prompts.mjs rules, using a FAKE bank and real Postgres (PGlite) for the apply step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateBank, planSeed } from '../scripts/lib/seed_plan.mjs';
import { parseDevVars } from '../scripts/lib/env.mjs';
import { createTestDatabase, fakeSupabase } from './helpers/pg_supabase.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/sample_bank.json', import.meta.url), 'utf8'));
const bank = () => structuredClone(FIXTURE);

// Does what seed_prompts.mjs does after planning.
async function apply(db, plan) {
  if (plan.inserts.length) { const { error } = await db.from('prompts').insert(plan.inserts); if (error) throw new Error(error.message); }
  for (const { id, row } of plan.updates) { const { error } = await db.from('prompts').update(row).eq('id', id); if (error) throw new Error(error.message); }
}
async function rows(db) { const { data } = await db.from('prompts').select('id,text,category,note,answers,needs_review,enabled'); return data; }
const byId = (list, id) => list.find(r => r.id === id);
const answer = (row, text) => row.answers.find(a => a.answer === text);

test('validateBank: errors stop the seed, unmatchable answers only warn', () => {
  assert.deepEqual(validateBank(bank()), { errors: [], warnings: [] });
  const b = bank();
  b.prompts[0].answers[0].tier = 'legendary';
  b.prompts[1].answers.push({ answer: 'OCEAN!', tier: 'rare' });
  b.prompts[2].answers.push({ answer: '朵拉', tier: 'rare' });
  b.prompts[3].answers.push({ answer: '⁉', tier: 'rare', aliases: ['interrobang'] });
  b.prompts.push({ ...b.prompts[4] });
  const { errors, warnings } = validateBank(b);
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.ok(errors.some(e => e.includes('unknown tier')) && errors.some(e => e.includes('duplicate answer')) && errors.some(e => e.includes('duplicate id')));
  assert.equal(warnings.length, 1, 'the ⁉ answer has a typeable alias, so only the CJK one warns');
});

test('first seed inserts everything; review prompts start disabled', async () => {
  const db = fakeSupabase(await createTestDatabase());
  const plan = planSeed(bank(), []);
  assert.equal(plan.inserts.length, 14);
  await apply(db, plan);
  const all = await rows(db);
  assert.equal(byId(all, 'likes-most-liked').enabled, false);
  assert.equal(byId(all, 'likes-most-liked').needs_review, true);
  assert.equal(all.filter(r => r.enabled).length, 13);
});

test('re-seeding keeps tier edits, alias edits and enabled; tier-only differences are not changes', async () => {
  const db = fakeSupabase(await createTestDatabase());
  await apply(db, planSeed(bank(), []));
  // An admin re-tiers an answer, adds an alias, disables one prompt and enables the review one.
  const row = byId(await rows(db), 'games-played');
  answer(row, 'Chess').tier = 'krillion';
  answer(row, 'Chess').aliases = ['checkmate'];
  await db.from('prompts').update({ answers: row.answers, enabled: false }).eq('id', 'games-played');
  await db.from('prompts').update({ enabled: true }).eq('id', 'likes-most-liked');
  // Same bank again, and also a bank that only disagrees about a tier.
  const b = bank();
  b.prompts.find(p => p.id === 'games-played').answers.find(a => a.answer === 'Chess').tier = 'plankton';
  for (const incoming of [bank(), b]) {
    const plan = planSeed(incoming, await rows(db));
    assert.equal(plan.changed.length, 0); assert.equal(plan.inserts.length, 0); assert.equal(plan.updates.length, 0);
    assert.equal(plan.unchanged.length, 14);
  }
  const after = await rows(db);
  assert.equal(answer(byId(after, 'games-played'), 'Chess').tier, 'krillion');
  assert.equal(byId(after, 'games-played').enabled, false);
  assert.equal(byId(after, 'likes-most-liked').enabled, true);
});

test('changed answers print a diff and need --force; forcing still keeps tiers, aliases and enabled', async () => {
  const db = fakeSupabase(await createTestDatabase());
  await apply(db, planSeed(bank(), []));
  const row = byId(await rows(db), 'media-shows');
  answer(row, 'Bake Off').tier = 'deepcut';
  answer(row, 'Bake Off').aliases = [...answer(row, 'Bake Off').aliases, 'bakeoff'];
  await db.from('prompts').update({ answers: row.answers, enabled: false }).eq('id', 'media-shows');

  const b = bank(), p = b.prompts.find(x => x.id === 'media-shows');
  p.answers.find(a => a.answer === 'Bake Off').weight = 31;           // weight changed
  p.answers = p.answers.filter(a => a.answer !== 'Moon Lawyers');     // answer removed
  p.answers.push({ answer: 'Ferry Tales', tier: 'rare', weight: 2 }); // answer added

  const plan = planSeed(b, await rows(db));
  assert.deepEqual(plan.changed.map(c => c.id), ['media-shows']);
  const diff = plan.changed[0].diff.join('\n');
  assert.match(diff, /\+ "Ferry Tales" \(rare\)/); assert.match(diff, /- "Moon Lawyers"/); assert.match(diff, /"Bake Off" weight: 30 -> 31/);
  assert.equal(plan.updates.length, 0, 'nothing is written without --force');

  const forced = planSeed(b, await rows(db), { force: true });
  assert.equal(forced.updates.length, 1);
  assert.ok(!('enabled' in forced.updates[0].row), 'enabled is never written for an existing prompt');
  await apply(db, forced);
  const after = byId(await rows(db), 'media-shows');
  assert.equal(after.enabled, false);
  assert.equal(answer(after, 'Bake Off').tier, 'deepcut');
  assert.equal(answer(after, 'Bake Off').weight, 31);
  assert.ok(answer(after, 'Bake Off').aliases.includes('bakeoff') && answer(after, 'Bake Off').aliases.includes('gbbo'));
  assert.equal(answer(after, 'Moon Lawyers'), undefined);
  assert.equal(answer(after, 'Ferry Tales').tier, 'rare');
  assert.equal(planSeed(b, await rows(db)).changed.length, 0, 'seeding the same bank again is a no-op');
});

test('prompts only in Supabase are left alone; .dev.vars parsing', async () => {
  const b = bank(); b.prompts = b.prompts.slice(1);
  const plan = planSeed(b, planSeed(bank(), []).inserts);
  assert.deepEqual(plan.onlyInDatabase, ['group-names']);
  assert.deepEqual(parseDevVars('# comment\nSUPABASE_URL=https://x.supabase.co\nSUPABASE_SERVICE_ROLE_KEY="abc=="\n\nBAD LINE\n'), { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'abc==' });
});
