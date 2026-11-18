// Schema tests on real Postgres (PGlite) with the real migrations: lockdown, atomic scoring,
// constraints, and the leaderboard / stats / streak views. No real chat data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/pg_supabase.mjs';

const TABLES = ['members', 'prompts', 'puzzles', 'runs', 'answers', 'guess_log'];
const VIEWS = ['daily_leaderboard', 'member_stats', 'member_streaks'];
const PROMPTS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];

async function member(pg, name) { return (await pg.query('insert into members (display_name) values ($1) returning id', [name])).rows[0].id; }
async function run(pg, memberId, date, { mode = 'daily', completed = true, scores = [] } = {}) {
  const id = (await pg.query('insert into runs (member_id, date, mode, prompt_ids, next_round, completed) values ($1,$2,$3,$4,$5,$6) returning id', [memberId, date, mode, PROMPTS, scores.length, completed])).rows[0].id;
  for (const [round, score] of scores.entries()) await pg.query('insert into answers (run_id, round, score, tier) values ($1,$2,$3,$4)', [id, round, score, score ? { 10: 'plankton', 30: 'schooler', 60: 'rare', 85: 'deepcut', 100: 'krillion' }[score] : null]);
  return id;
}
async function denied(pg, role, sql) {
  await pg.exec(`set role ${role}`);
  try { await pg.query(sql); return false; } catch (e) { return /permission denied/.test(e.message); } finally { await pg.exec('reset role'); }
}

test('RLS is on for every table, and anon/authenticated can touch nothing', async () => {
  const pg = await createTestDatabase();
  const rls = (await pg.query("select tablename from pg_tables where schemaname = 'public' and rowsecurity")).rows.map(r => r.tablename).sort();
  assert.deepEqual(rls, [...TABLES].sort());
  assert.equal((await pg.query("select count(*)::int as n from pg_policies where schemaname = 'public'")).rows[0].n, 0, 'no policies at all');
  for (const role of ['anon', 'authenticated']) {
    for (const t of [...TABLES, ...VIEWS]) assert.ok(await denied(pg, role, `select * from ${t}`), `${role} read ${t}`);
    assert.ok(await denied(pg, role, "insert into prompts (id, text, category, answers) values ('x','x','x','[]')"), `${role} insert`);
    assert.ok(await denied(pg, role, "select score_round(gen_random_uuid(), 0, null, null, null, 0, 7)"), `${role} rpc`);
  }
});

test('score_round scores a round once, advances the run, and refuses closed or paused rounds', async () => {
  const pg = await createTestDatabase(), m = await member(pg, 'Avery');
  const id = (await pg.query("insert into runs (member_id, date, mode, prompt_ids, round_start) values ($1, '2026-11-20', 'daily', $2, 1000) returning id", [m, PROMPTS])).rows[0].id;
  const score = (round, s) => pg.query('select score_round($1, $2, $3, $4, $5, $6, 7) as ok', [id, round, 'raw', 'Ans', s ? 'krillion' : null, s]).then(r => r.rows[0].ok);
  const [a, b] = await Promise.all([score(0, 100), score(0, 100)]);
  assert.deepEqual([a, b].sort(), [false, true], 'two racing submissions score once');
  assert.equal(await score(0, 100), false, 'retry is refused');
  assert.equal(await score(1, 100), false, 'next round is not open until round_start is set');
  let r = (await pg.query('select next_round, round_start, completed from runs where id = $1', [id])).rows[0];
  assert.deepEqual(r, { next_round: 1, round_start: null, completed: false });
  await pg.query('update runs set round_start = 2000, paused_at = 2500 where id = $1', [id]);
  assert.equal(await score(1, 100), false, 'paused run is refused');
  await pg.query('update runs set paused_at = null where id = $1', [id]);
  for (let i = 1; i < 7; i++) { await pg.query('update runs set round_start = 1 where id = $1', [id]); assert.equal(await score(i, i === 6 ? 0 : 10), true); }
  r = (await pg.query('select next_round, completed from runs where id = $1', [id])).rows[0];
  assert.deepEqual(r, { next_round: 7, completed: true });
  assert.equal((await pg.query('select sum(score)::int as s from answers where run_id = $1', [id])).rows[0].s, 150);
});

test('constraints: one daily run per member per day, valid scores and tiers, 7 prompts', async () => {
  const pg = await createTestDatabase(), m = await member(pg, 'Bea');
  await run(pg, m, '2026-11-20');
  await assert.rejects(run(pg, m, '2026-11-20'), /duplicate key/);
  await run(pg, m, '2026-11-20', { mode: 'practice' }); await run(pg, m, '2026-11-20', { mode: 'practice' });
  const r = await run(pg, m, '2026-11-21', { scores: [] });
  await assert.rejects(pg.query('insert into answers (run_id, round, score) values ($1, 0, 99999)', [r]), /check/);
  await assert.rejects(pg.query("insert into answers (run_id, round, score, tier) values ($1, 0, 10, 'legendary')", [r]), /check/);
  await assert.rejects(pg.query("insert into puzzles (date, day_number, prompt_ids) values ('2026-11-20', 1, $1)", [['a', 'b']]), /check/);
  await assert.rejects(pg.query("insert into prompts (id, text, category, answers) values ('Bad Id!', 't', 'c', '[]')"), /check/);
  await assert.rejects(member(pg, 'bea'), /duplicate key/, 'display names are unique ignoring case');
});

test('views: daily leaderboard, all-time stats and streaks count completed daily dives only', async () => {
  const pg = await createTestDatabase();
  const today = (await pg.query("select (now() at time zone 'America/Vancouver')::date::text as d")).rows[0].d;
  const day = n => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const a = await member(pg, 'Avery'), b = await member(pg, 'Bea'), c = await member(pg, 'Cosmo');
  // Avery: 3 days in a row ending today; Bea: 2 days ending 3 days ago; Cosmo: practice and an unfinished daily only.
  for (const n of [-2, -1, 0]) await run(pg, a, day(n), { scores: [100, 60, 10] });
  for (const n of [-4, -3]) await run(pg, b, day(n), { scores: [30, 30] });
  await run(pg, b, day(0), { scores: [100, 100, 100, 85] });
  await run(pg, c, day(0), { mode: 'practice', scores: [100, 100, 100, 100] });
  await run(pg, c, day(-1), { completed: false, scores: [100] });
  const board = (await pg.query('select display_name, score, rank, tiers from daily_leaderboard where date = $1 order by rank', [day(0)])).rows;
  assert.deepEqual(board.map(r => [r.display_name, r.score, r.rank]), [['Bea', 385, 1], ['Avery', 170, 2]]);
  assert.deepEqual(board[1].tiers, ['krillion', 'rare', 'plankton']);
  const stats = Object.fromEntries((await pg.query('select display_name, dives, average, best, total from member_stats')).rows.map(r => [r.display_name, r]));
  assert.deepEqual(stats.Avery, { display_name: 'Avery', dives: 3, average: 170, best: 170, total: 510 });
  assert.deepEqual(stats.Cosmo, { display_name: 'Cosmo', dives: 0, average: 0, best: 0, total: 0 });
  const streaks = Object.fromEntries((await pg.query('select m.display_name, s.best_streak, s.current_streak from member_streaks s join members m on m.id = s.member_id')).rows.map(r => [r.display_name, [r.best_streak, r.current_streak]]));
  assert.deepEqual(streaks.Avery, [3, 3]);
  assert.deepEqual(streaks.Bea, [2, 1], 'the gap breaks the streak; today starts a new one');
  assert.equal(streaks.Cosmo, undefined);
});
