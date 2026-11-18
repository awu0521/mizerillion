// Preview mode (before the launch date): full game, no names, nothing stored. Admin sets the date.
// Made-up passwords and the FAKE bank only. Runs on both stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ORIGIN } from './helpers/app.mjs';
import { PREVIEW_MS, ROUND_MS, dayNumber, shareText } from '../public/rules.mjs';
import { choosePuzzleIds } from '../src/puzzle.mjs';

// The harness clock starts 2026-11-20 10:00 in Vancouver.
const LAUNCH = '2026-12-01';

async function counts(h) {
  if (h.pg) {
    const one = async t => (await h.pg.query(`select count(*)::int as n from ${t}`)).rows[0].n;
    return { runs: await one('runs'), answers: await one('answers'), guesses: await one('guess_log'), puzzles: await one('puzzles') };
  }
  return { runs: h.store.runs.size, answers: h.store.answers.length, guesses: h.store.guesses.length, puzzles: h.store.puzzles.size };
}
async function previewHarness(kind) {
  const h = await harness(kind), admin = await h.admin();
  assert.equal((await admin.admin('launch-date', { date: LAUNCH })).status, 200);
  return { h, admin };
}
async function answerOf(h, token, round, tier = 'krillion') {
  const body = JSON.parse(Buffer.from(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  const [p] = await h.store.promptsByIds([body.prompt_ids[round]]);
  return p.answers.find(a => a.tier === tier) || p.answers[0];
}

for (const kind of ['memory', 'supabase']) {
  test(kind + ': before the launch date: no name needed, full dives, and nothing is stored', async () => {
    const { h } = await previewHarness(kind);
    const b = h.browser(); await b.login();
    const s = (await b.call('/api/session')).body;
    assert.equal(s.member, null); assert.deepEqual(s.preview, { launchDate: LAUNCH });
    const today = (await b.call('/api/today')).body;
    assert.equal(today.preview, true); assert.equal(today.dayNumber, 0); assert.equal(today.member, null);
    const before = await counts(h);
    let g = (await b.call('/api/start', {})).body;
    assert.equal(g.mode, 'preview'); assert.equal(g.dayNumber, 0); assert.equal(g.launchDate, LAUNCH);
    assert.match(g.runId, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(g.prompts.filter(Boolean).length, 1, 'only the current prompt is sent');
    let total = 0;
    for (let i = 0; i < 7; i++) {
      h.clock.t += PREVIEW_MS + 500;
      if (i === 0) { const r = await b.call('/api/answer', { runId: g.runId, round: 0, answer: 'zzzzzzzzzz' }); assert.equal(r.body.rejected, true); }
      const a = await answerOf(h, g.runId, i, i % 2 ? 'plankton' : 'krillion');
      const r = await b.call('/api/answer', { runId: g.runId, round: i, answer: a.answer, confirm: true, score: 99999 });
      assert.equal(r.status, 200); total += r.body.result.score; g = r.body.state;
      // Replaying an old token for a scored round doesn't score it twice in the same dive.
      if (i < 6) g = (await b.call('/api/next', { runId: g.runId })).body;
    }
    assert.equal(g.completed, true); assert.equal(g.score, total); assert.equal(total, 4 * 100 + 3 * 10);
    const review = await b.call('/api/review?run=' + encodeURIComponent(g.runId));
    assert.equal(review.status, 200); assert.equal(review.body.prompts.length, 7); assert.deepEqual(review.body.board, []);
    assert.deepEqual(await counts(h), before, 'no runs, answers, guesses or puzzles were written');
    assert.equal(shareText(0, g.results, 'preview').split('\n')[0], 'Mizerillion preview 🦐');
  });

  test(kind + ': preview tokens can\'t be forged, altered, shared or carried to another day', async () => {
    const { h } = await previewHarness(kind);
    const b = h.browser(); await b.login();
    const g = (await b.call('/api/start', {})).body;
    const [body, sig] = g.runId.split('.');
    const data = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    const forge = obj => Buffer.from(JSON.stringify(obj)).toString('base64url') + '.' + sig;
    assert.equal((await b.call('/api/state?run=' + encodeURIComponent(forge({ ...data, results: [{ round: 0, score: 100, tier: 'krillion' }], next_round: 1 })))).status, 404, 'altered results');
    assert.equal((await b.call('/api/state?run=' + encodeURIComponent(forge({ ...data, round_start: data.round_start + 3600e3 })))).status, 404, 'more time');
    assert.equal((await b.call('/api/state?run=' + encodeURIComponent(body + '.' + 'A'.repeat(43)))).status, 404, 'bad signature');
    assert.equal((await b.call('/api/state?run=not-a-token')).status, 404);
    const other = h.browser({ ip: '192.0.2.50' }); await other.login();
    assert.equal((await other.call('/api/state?run=' + encodeURIComponent(g.runId))).status, 404, "another person's session can't use it");
    assert.equal((await b.call('/api/state?run=' + encodeURIComponent(g.runId))).status, 200);
    h.clock.t += 24 * 3600e3;
    assert.equal((await b.call('/api/state?run=' + encodeURIComponent(g.runId))).status, 404, "yesterday's preview dive is gone");
  });

  test(kind + ': preview keeps the clock rules and avoids the launch-day prompts', async () => {
    const { h } = await previewHarness(kind);
    const b = h.browser(); await b.login();
    let g = (await b.call('/api/start', {})).body;
    const a0 = await answerOf(h, g.runId, 0);
    assert.equal((await b.call('/api/answer', { runId: g.runId, round: 0, answer: a0.answer })).status, 409, 'not open during the preview countdown');
    h.clock.t = g.roundStart + ROUND_MS + 1;
    assert.equal((await b.call('/api/answer', { runId: g.runId, round: 0, answer: a0.answer, confirm: true })).body.result.score, 0, 'late answers are a miss');
    const launchIds = await choosePuzzleIds(h.store, LAUNCH);
    const ids = JSON.parse(Buffer.from(g.runId.split('.')[0], 'base64url').toString()).prompt_ids;
    // 13 prompts are on and 7 are set aside for launch day; the category caps can block a few of the
    // other 6, so a little overlap is allowed, but most prompts come from outside the launch-day set.
    assert.ok(ids.filter(id => !launchIds.includes(id)).length >= 4, JSON.stringify({ ids, launchIds }));
  });

  test(kind + ': at midnight on the launch date the real game starts', async () => {
    const { h } = await previewHarness(kind);
    const b = h.browser(); await b.login();
    const g = (await b.call('/api/start', {})).body;
    h.clock.t = Date.parse('2026-12-01T08:00:00Z'); // midnight in Vancouver
    const s = (await b.call('/api/session')).body;
    assert.equal(s.preview, null);
    assert.equal((await b.call('/api/start', {})).status, 409, 'now a name is needed');
    assert.equal((await b.call('/api/state?run=' + encodeURIComponent(g.runId))).status, 409, 'the real game asks for a name first');
    await b.call('/api/member', { memberId: (await b.call('/api/members')).body.members[0].id });
    assert.equal((await b.call('/api/state?run=' + encodeURIComponent(g.runId))).status, 404, 'preview dives end at launch');
    const p = await h.player({ name: 'Bea' });
    const real = (await p.call('/api/start', {})).body;
    assert.equal(real.mode, 'daily'); assert.equal(real.dayNumber, 1, 'launch day is Dive #1');
    assert.equal((await counts(h)).runs, 1, 'real dives are stored again');
  });

  test(kind + ': admin launch date: validation, audit, day numbers and the upcoming preview', async () => {
    const h = await harness(kind), a = await h.admin();
    const st = (await a.admin('settings')).body;
    assert.deepEqual([st.launchDate, st.preview, st.diveToday], ['2026-11-17', false, 4], 'defaults to site.mjs');
    for (const bad of ['2026-02-30', '12/01/2026', '', 'tomorrow', 20261201]) assert.equal((await a.admin('launch-date', { date: bad })).status, 400, String(bad));
    assert.equal((await a.admin('launch-date', { date: LAUNCH, extra: 1 })).status, 400);
    assert.equal((await a.raw('/api/admin/launch-date', { method: 'POST', body: JSON.stringify({ date: LAUNCH }), headers: { 'Content-Type': 'application/json', Origin: ORIGIN } })).status, 403, 'needs CSRF');
    const player = await h.player();
    assert.equal((await player.admin('launch-date', { date: LAUNCH })).status, 401, 'players cannot change it');
    const set = (await a.admin('launch-date', { date: LAUNCH })).body;
    assert.deepEqual([set.launchDate, set.preview, set.diveToday], [LAUNCH, true, null]);
    const entry = (await a.admin('audit')).body.entries.find(e => e.action === 'launch_date');
    assert.deepEqual([entry.oldValue, entry.newValue], ['2026-11-17', LAUNCH]);
    const preview = (await a.admin('preview')).body;
    assert.deepEqual([preview.today.label, preview.today.date, preview.today.dayNumber], ['Launch day', LAUNCH, 1]);
    assert.deepEqual([preview.tomorrow.label, preview.tomorrow.dayNumber], ['The day after', 2]);
    // Back to a past date: live again, numbered from it.
    const live = (await a.admin('launch-date', { date: '2026-11-18' })).body;
    assert.deepEqual([live.preview, live.diveToday], [false, 3]);
    assert.equal(dayNumber('2026-11-20', '2026-11-18'), 3);
    assert.equal((await player.call('/api/today')).body.dayNumber, 3);
  });
}
