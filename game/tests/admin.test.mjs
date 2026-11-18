// Admin password, sessions, CSRF, input validation, the tier/alias/enabled editor and the audit log.
// Made-up passwords and the FAKE bank only. Every test runs on both stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ORIGIN, TEST_ADMIN_PASSWORD, TEST_PASSWORD, FIXTURE_BANK } from './helpers/app.mjs';
import { hashPassword, sha256hex } from '../src/auth.mjs';
import { planSeed } from '../scripts/lib/seed_plan.mjs';
import { PREVIEW_MS, matchAnswer } from '../public/rules.mjs';

const MIN = 60e3, HOUR = 3600e3;
const ADMIN_READS = ['prompts', 'prompt?id=games-played', 'audit', 'preview'];
const ADMIN_WRITES = [['tier', { promptId: 'games-played', answer: 'Chess', tier: 'krillion' }], ['aliases', { promptId: 'games-played', answer: 'Chess', aliases: ['x'] }], ['enabled', { promptId: 'games-played', enabled: false }], ['logout', {}]];

for (const kind of ['memory', 'supabase']) {
  test(kind + ': without an admin session, /api/admin/* returns 401 with no data; the page itself has no data', async () => {
    const h = await harness(kind), b = h.browser();
    const page = await b.raw('/admin');
    assert.equal(page.status, 200); assert.match(page.text, /admin-login-form/);
    for (const p of FIXTURE_BANK.prompts) assert.ok(!page.text.includes(p.text));
    assert.deepEqual((await b.admin('session')).body, { authenticated: false });
    for (const path of ADMIN_READS) { const r = await b.admin(path); assert.equal(r.status, 401, path); assert.deepEqual(r.body, { error: 'Admin only.' }); }
    for (const [path, data] of ADMIN_WRITES) { const r = await b.admin(path, data); assert.equal(r.status, 401, path); assert.deepEqual(r.body, { error: 'Admin only.' }); }
  });

  test(kind + ': player and admin sessions are separate', async () => {
    const h = await harness(kind), player = await h.player();
    assert.equal((await player.admin('prompts')).status, 401, 'a player session is not an admin session');
    assert.equal((await player.adminLogin(TEST_PASSWORD)).status, 401, 'the player password is not the admin password');
    const admin = await h.admin();
    assert.equal((await admin.call('/api/today')).status, 401, 'an admin session is not a player session');
    assert.match((await admin.raw('/')).text, /id="login-form"/);
    assert.equal((await admin.login(TEST_ADMIN_PASSWORD)).status, 401, 'the admin password is not the player password');
  });

  test(kind + ': wrong, empty and malformed admin passwords get the same "Wrong password"; every attempt is audited', async () => {
    const h = await harness(kind), b = h.browser();
    for (const body of [{ password: 'nope-nope-nope' }, { password: '' }, { password: 42 }, { password: null }, {}]) {
      const r = await b.raw('/api/admin/login', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: ORIGIN } });
      assert.equal(r.status, 401); assert.deepEqual(r.body, { error: 'Wrong password' }); assert.equal(r.setCookie, null);
    }
    assert.equal((await b.adminLogin()).status, 429, 'five failures locked this IP');
    const b2 = h.browser({ ip: '198.51.100.200' }), ok = await b2.adminLogin(); // from another IP
    assert.equal(ok.status, 200);
    const m = /^__Host-admin=([A-Za-z0-9_-]{43}); HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/.exec(ok.setCookie);
    assert.ok(m, ok.setCookie);
    const stored = await h.store.getSession('admin', await sha256hex(m[1]));
    assert.ok(stored && !JSON.stringify(stored).includes(m[1]), 'only the hash is stored');
    const audit = (await b2.admin('audit')).body.entries;
    assert.equal(audit.filter(e => e.action === 'login_failed').length, 5);
    assert.equal(audit.filter(e => e.action === 'login').length, 1);
    assert.equal(audit.filter(e => e.action === 'login_blocked').length, 1);
    await b2.admin('prompts'); await b2.admin('prompt?id=games-played'); await b2.admin('preview');
    assert.ok(b2.seen.every(t => !t.includes(m[1])), 'the token never appears in a response body');
  });

  test(kind + ': admin lockouts: per IP (doubling) and global, separate from player lockouts', async () => {
    const h = await harness(kind), attacker = h.browser({ ip: '192.0.2.66' });
    for (let i = 0; i < 5; i++) assert.equal((await attacker.adminLogin('guess-' + i)).status, 401);
    assert.equal((await attacker.adminLogin()).status, 429, 'even the right password');
    assert.equal((await attacker.login()).status, 200, 'player login from that IP is a separate counter');
    assert.equal((await h.browser({ ip: '192.0.2.10' }).adminLogin()).status, 200, 'another IP is fine');
    assert.equal((await attacker.adminLogin()).status, 429, "another IP's success doesn't unlock this one");
    h.clock.t += 15 * MIN + 1000;
    for (let i = 0; i < 5; i++) await attacker.adminLogin('again-' + i);
    h.clock.t += 16 * MIN; assert.equal((await attacker.adminLogin()).status, 429, 'second lockout is 30 minutes');
    h.clock.t += 15 * MIN; assert.equal((await attacker.adminLogin()).status, 200);
    assert.ok((await (await h.admin({ ip: '192.0.2.11' })).admin('audit')).body.entries.some(e => e.action === 'login_blocked'), 'blocked attempts are audited');

    const g = await harness(kind);
    for (let i = 0; i < 50; i++) { await g.browser({ ip: `10.1.${i >> 8}.${i & 255}` }).adminLogin('spray-' + i); g.clock.t += 1000; }
    assert.equal((await g.browser({ ip: '172.16.0.9' }).adminLogin()).status, 429, 'global lockout');
    assert.equal((await g.browser({ ip: '172.16.0.9' }).login()).status, 200, 'players can still log in');
    g.clock.t += HOUR + MIN; assert.equal((await g.browser({ ip: '172.16.0.9' }).adminLogin()).status, 200);
  });

  test(kind + ': admin sessions end after 30 idle minutes, 8 hours total, on logout, and when the hash changes', async () => {
    const h = await harness(kind);
    const idle = await h.admin();
    h.clock.t += 29 * MIN; assert.equal((await idle.admin('prompts')).status, 200, 'activity resets the idle clock');
    h.clock.t += 29 * MIN; assert.equal((await idle.admin('prompts')).status, 200);
    h.clock.t += 30 * MIN + 1000; assert.equal((await idle.admin('prompts')).status, 401, 'idle for 30 minutes');

    const busy = await h.admin({ ip: '192.0.2.20' });
    for (let i = 0; i < 16; i++) { h.clock.t += 29 * MIN; assert.equal((await busy.admin('prompts')).status, 200, 'hour ' + (i * 29 / 60).toFixed(1)); }
    h.clock.t += 20 * MIN; assert.equal((await busy.admin('prompts')).status, 401, 'over 8 hours total');

    const leaving = await h.admin({ ip: '192.0.2.21' }), token = leaving.jar.get('__Host-admin');
    const out = await leaving.admin('logout', {});
    assert.equal(out.status, 200); assert.match(out.setCookie, /Max-Age=0/);
    leaving.jar.set('__Host-admin', token);
    assert.equal((await leaving.admin('prompts')).status, 401, 'revoked on the server, not just the cookie');

    const steady = await h.admin({ ip: '192.0.2.22' });
    h.env.ADMIN_PASSWORD_HASH = await hashPassword('a fresh made-up admin password');
    assert.equal((await steady.admin('prompts')).status, 401, 'a new hash ends every admin session');
    assert.equal((await h.browser({ ip: '192.0.2.23' }).adminLogin(TEST_ADMIN_PASSWORD)).status, 401, 'the old admin password stops working');
    assert.equal((await h.browser({ ip: '192.0.2.24' }).adminLogin('a fresh made-up admin password')).status, 200);
  });

  test(kind + ': admin CSRF: changes need a mutating method, this Origin and the session token', async () => {
    const h = await harness(kind), a = await h.admin(), body = JSON.stringify({ promptId: 'games-played', enabled: false });
    const send = (method, headers) => a.raw('/api/admin/enabled', { method, body: method === 'GET' ? undefined : body, headers: { 'Content-Type': 'application/json', ...headers } });
    assert.equal((await send('POST', { 'X-CSRF-Token': a.adminCsrf })).status, 403, 'no Origin');
    assert.equal((await send('POST', { Origin: 'https://evil.example', 'X-CSRF-Token': a.adminCsrf })).status, 403, 'wrong Origin');
    assert.equal((await send('POST', { Origin: ORIGIN })).status, 403, 'no token');
    assert.equal((await send('POST', { Origin: ORIGIN, 'X-CSRF-Token': 'f'.repeat(43) })).status, 403, 'wrong token');
    const player = await h.player();
    assert.equal((await send('POST', { Origin: ORIGIN, 'X-CSRF-Token': player.csrf })).status, 403, "the player CSRF token doesn't work for admin");
    assert.equal((await send('GET')).status, 404, 'GET cannot change anything');
    assert.equal((await a.raw('/api/admin/prompts', { method: 'OPTIONS' })).status, 405);
    assert.equal((await a.admin('prompt?id=games-played')).body.prompt.enabled, true, 'nothing changed');
    assert.equal((await send('POST', { Origin: ORIGIN, 'X-CSRF-Token': a.adminCsrf })).status, 200);
  });

  test(kind + ': admin input validation: tiers, prompts, answers, unknown fields, size', async () => {
    const h = await harness(kind), a = await h.admin();
    const bad = async (path, data, status, pattern) => { const r = await a.admin(path, data); assert.equal(r.status, status, JSON.stringify(data)); if (pattern) assert.match(r.body.error, pattern); };
    await bad('tier', { promptId: 'games-played', answer: 'Chess', tier: 'legendary' }, 400, /Tier must be one of/);
    await bad('tier', { promptId: 'games-played', answer: 'Chess', tier: 100 }, 400, /Tier must be one of/);
    await bad('tier', { promptId: 'no-such-prompt', answer: 'Chess', tier: 'rare' }, 404, /No such prompt/);
    await bad('tier', { promptId: "games'; drop table prompts;--", answer: 'Chess', tier: 'rare' }, 404);
    await bad('tier', { promptId: 'games-played', answer: 'Checkers', tier: 'rare' }, 400, /No such answer/);
    await bad('tier', { promptId: 'games-played', answer: 'chess', tier: 'rare' }, 400, /No such answer/);
    await bad('tier', { promptId: 'games-played', answer: 'Chess', tier: 'rare', score: 999 }, 400, /Unknown field: score/);
    await bad('tier', ['games-played'], 400);
    await bad('enabled', { promptId: 'games-played', enabled: 'yes' }, 400);
    await bad('aliases', { promptId: 'games-played', answer: 'Chess', aliases: 'checkmate' }, 400);
    await bad('aliases', { promptId: 'games-played', answer: 'Chess', aliases: ['mk'] }, 400, /already matches "Mario Kart"/);
    await bad('aliases', { promptId: 'games-played', answer: 'Chess', aliases: ['!!!'] }, 400, /never match/);
    await bad('aliases', { promptId: 'games-played', answer: 'Chess', aliases: ['x'.repeat(81)] }, 400);
    await bad('aliases', { promptId: 'games-played', answer: 'Chess', aliases: Array.from({ length: 51 }, (_, i) => 'a' + i) }, 400);
    const huge = await a.raw('/api/admin/tier', { method: 'POST', body: JSON.stringify({ promptId: 'games-played', answer: 'Chess', tier: 'x'.repeat(20000) }), headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-CSRF-Token': a.adminCsrf } });
    assert.equal(huge.status, 413);
    const p = (await a.admin('prompt?id=games-played')).body.prompt;
    assert.equal(p.answers.find(x => x.answer === 'Chess').tier, 'tooclever', 'nothing was changed by any of that');
  });

  test(kind + ': tier edits save, are audited, apply to later rounds, never change past scores, and can be undone', async () => {
    const h = await harness(kind), a = await h.admin();
    // A player scores "Chess" (Too Clever, 15) before the edit.
    const before = await h.player({ name: 'Avery' });
    let g = (await before.call('/api/start', {})).body;
    const run = await h.store.getRun(g.runId), round = run.prompt_ids.indexOf('games-played');
    for (let i = 0; i <= round; i++) {
      h.clock.t += PREVIEW_MS + 500;
      const answer = i === round ? 'Chess' : '';
      const r = await before.call('/api/answer', { runId: g.runId, round: i, answer, timeout: !answer, confirm: true });
      if (i === round) assert.equal(r.body.result.score, 15);
      if (i < 6) g = (await before.call('/api/next', { runId: g.runId })).body;
    }
    // The admin moves Chess to One in a Krillion.
    const saved = await a.admin('tier', { promptId: 'games-played', answer: 'Chess', tier: 'krillion' });
    assert.equal(saved.status, 200); assert.equal(saved.body.oldTier, 'tooclever');
    const chess = saved.body.prompt.answers.find(x => x.answer === 'Chess');
    assert.equal(chess.tier, 'krillion'); assert.deepEqual(saved.body.prompt.warnings, ['2 One in a Krillion answers (usually there\'s one).']);
    assert.equal((await h.store.promptFull('games-played')).answers.find(x => x.answer === 'Chess').tier, 'krillion', 'prompts.answers changed');
    const entry = (await a.admin('audit')).body.entries.find(e => e.action === 'tier');
    assert.deepEqual([entry.promptId, entry.answer, entry.oldValue, entry.newValue, entry.mine], ['games-played', 'Chess', 'tooclever', 'krillion', true]);
    // The earlier score stays 15.
    assert.equal((await h.store.answersFor(g.runId)).find(x => x.round === round).score, 15);
    // A later player the same day gets 100.
    const after = await h.player({ name: 'Bea' });
    let g2 = (await after.call('/api/start', {})).body;
    for (let i = 0; i <= round; i++) {
      h.clock.t += PREVIEW_MS + 500;
      const answer = i === round ? 'chess' : '';
      const r = await after.call('/api/answer', { runId: g2.runId, round: i, answer, timeout: !answer, confirm: true });
      if (i === round) assert.equal(r.body.result.score, 100);
      if (i < 6) g2 = (await after.call('/api/next', { runId: g2.runId })).body;
    }
    // Undo puts it back, and that's audited too.
    const undo = await a.admin('tier', { promptId: 'games-played', answer: 'Chess', tier: 'tooclever' });
    assert.equal(undo.body.prompt.answers.find(x => x.answer === 'Chess').tier, 'tooclever');
    assert.equal((await a.admin('audit')).body.entries.filter(e => e.action === 'tier').length, 2);
    // Re-seeding keeps an admin tier edit.
    await a.admin('tier', { promptId: 'media-shows', answer: 'Bake Off', tier: 'deepcut' });
    const rows = await h.store.adminPrompts();
    assert.equal(planSeed(FIXTURE_BANK, rows).changed.length, 0, 're-seeding sees no change and keeps the tier');
  });

  test(kind + ': prompt list, warnings, enabled toggle, aliases, wrong guesses and the preview', async () => {
    const h = await harness(kind), a = await h.admin();
    const list = (await a.admin('prompts')).body.prompts;
    assert.equal(list.length, FIXTURE_BANK.prompts.length);
    const review = list.find(p => p.id === 'likes-most-liked');
    assert.equal(review.enabled, false); assert.equal(review.needsReview, true);
    assert.deepEqual(list.find(p => p.id === 'games-played').counts, { plankton: 1, tooclever: 1, schooler: 1, rare: 1, deepcut: 1, krillion: 1 });
    // Warnings: no Plankton, no Krillion.
    await a.admin('tier', { promptId: 'media-songs', answer: 'Krill Me Softly', tier: 'schooler' });
    const songs = await a.admin('tier', { promptId: 'media-songs', answer: 'Lullaby for a Lobster', tier: 'deepcut' });
    assert.deepEqual(songs.body.prompt.warnings, ['No One in a Krillion answer.', 'No Plankton answer.']);
    // Enabled toggle.
    assert.equal((await a.admin('enabled', { promptId: 'likes-most-liked', enabled: true })).body.prompt.enabled, true);
    assert.ok((await h.store.enabledPrompts()).some(p => p.id === 'likes-most-liked'));
    // A wrong guess shows up, gets added as an alias, then counts.
    const p = await h.player();
    let g = (await p.call('/api/start', {})).body;
    const run = await h.store.getRun(g.runId), id = run.prompt_ids[0];
    h.clock.t += PREVIEW_MS + 500;
    await p.call('/api/answer', { runId: g.runId, round: 0, answer: 'Zebra Crossing' });
    await p.call('/api/answer', { runId: g.runId, round: 0, answer: 'zebra crossing!' });
    const detail = (await a.admin('prompt?id=' + id)).body;
    assert.deepEqual(detail.guesses.map(x => [x.normalized, x.count]), [['zebracrossing', 2]]);
    const target = detail.prompt.answers[0];
    const added = await a.admin('aliases', { promptId: id, answer: target.answer, aliases: [...target.aliases, detail.guesses[0].example] });
    assert.equal(added.status, 200);
    assert.ok(added.body.prompt.answers[0].aliases.includes(detail.guesses[0].example));
    const scored = await p.call('/api/answer', { runId: g.runId, round: 0, answer: 'Zebra Crossing', confirm: true });
    assert.equal(scored.body.result.answer, target.answer, 'the new alias matches');
    assert.ok((await a.admin('audit')).body.entries.some(e => e.action === 'aliases' && e.promptId === id));
    // Preview: today (fixed, since a dive started) and tomorrow (not chosen yet).
    const preview = (await a.admin('preview')).body;
    assert.equal(preview.today.fixed, true); assert.deepEqual(preview.today.prompts.map(x => x.id), run.prompt_ids);
    assert.equal(preview.tomorrow.fixed, false); assert.equal(preview.tomorrow.prompts.length, 7);
    assert.equal(preview.tomorrow.date, '2026-11-21');
  });

  test(kind + ': new prompts: create, add answers, edit the question and answers, delete, switch on', async () => {
    const h = await harness(kind), a = await h.admin();
    const bad = async (path, data, pattern) => { const r = await a.admin(path, data); assert.equal(r.status, 400, JSON.stringify(data)); if (pattern) assert.match(r.body.error, pattern); };
    await bad('create-prompt', { text: '   ', category: 'likes' }, /question needs/);
    await bad('create-prompt', { text: 'Name a snack', category: '!!' }, /category/);
    await bad('create-prompt', { text: 'Name a snack', category: 'likes', enabled: true }, /Unknown field: enabled/);
    const made = await a.admin('create-prompt', { text: '  Name a snack the chat loves ', category: 'Likes' });
    assert.equal(made.status, 200);
    const p = made.body.prompt;
    assert.deepEqual([p.id, p.text, p.category, p.enabled, p.answerCount, p.createdHere], ['name-a-snack-the-chat-loves', 'Name a snack the chat loves', 'likes', false, 0, true]);
    assert.equal((await a.admin('create-prompt', { text: 'Name a snack the chat loves', category: 'likes' })).body.prompt.id, 'name-a-snack-the-chat-loves-2', 'same question gets a new id');
    await bad('enabled', { promptId: p.id, enabled: true }, /at least one answer/);
    // Answers.
    await bad('add-answer', { promptId: p.id, answer: 'Pocky' }, /Pick a tier/);
    await bad('add-answer', { promptId: p.id, answer: '!!!', tier: 'rare' }, /nobody could type it/);
    for (const [answer, tier] of [['Pocky', 'plankton'], ['Shrimp chips', 'schooler'], ['Seaweed', 'rare'], ['Mochi', 'deepcut'], ['Dried squid', 'krillion']]) assert.equal((await a.admin('add-answer', { promptId: p.id, answer, tier })).status, 200, answer);
    await bad('add-answer', { promptId: p.id, answer: 'pocky!', tier: 'rare' }, /already matches "Pocky"/);
    await bad('add-answer', { promptId: p.id, answer: 'Kale chips', tier: 'rare', aliases: ['mochi'] }, /already matches "Mochi"/);
    const withAlias = await a.admin('add-answer', { promptId: p.id, answer: '🍙', tier: 'rare', aliases: ['onigiri', 'rice ball'], quip: 'Dora brings these' });
    assert.deepEqual(withAlias.body.prompt.answers.at(-1), { answer: '🍙', aliases: ['onigiri', 'rice ball'], tier: 'rare', weight: null, quip: 'Dora brings these', autoPick: false, addedHere: true });
    assert.equal((await a.admin('enabled', { promptId: p.id, enabled: true })).body.prompt.enabled, true);
    assert.ok((await h.store.enabledPrompts()).some(x => x.id === p.id), 'can now be picked for dives');
    // Edit the question.
    const edited = await a.admin('edit-prompt', { promptId: p.id, text: 'Name a snack this chat brings to hangouts' });
    assert.equal(edited.body.prompt.text, 'Name a snack this chat brings to hangouts'); assert.equal(edited.body.prompt.id, p.id, 'the id stays');
    await bad('edit-prompt', { promptId: p.id }, /Nothing to change/);
    // Edit an answer: rename, aliases, quip; clashes refused.
    const renamed = await a.admin('edit-answer', { promptId: p.id, answer: 'Pocky', newAnswer: 'Pocky sticks', aliases: ['pocky'], quip: 'Gone in seconds' });
    assert.equal(renamed.status, 200);
    const pocky = renamed.body.prompt.answers.find(x => x.answer === 'Pocky sticks');
    assert.deepEqual([pocky.aliases, pocky.quip, pocky.tier], [['pocky'], 'Gone in seconds', 'plankton']);
    await bad('edit-answer', { promptId: p.id, answer: 'Mochi', newAnswer: 'seaweed' }, /already matches "Seaweed"/);
    await bad('edit-answer', { promptId: p.id, answer: 'Mochi', aliases: ['onigiri'] }, /already matches "🍙"/);
    await bad('edit-answer', { promptId: p.id, answer: 'Nope', quip: 'x' }, /No such answer/);
    assert.equal((await a.admin('edit-answer', { promptId: p.id, answer: 'Mochi', quip: '' })).status, 200, 'clearing a quip is fine');
    // The game matches with the edited data.
    const stored = await h.store.promptFull(p.id);
    assert.equal(matchAnswer('pocky', stored.answers).answer, 'Pocky sticks');
    assert.equal(matchAnswer('onigiri', stored.answers).answer, '🍙');
    // Delete: fine normally; refused for the last answer of a prompt that's on.
    const deleted = await a.admin('delete-answer', { promptId: p.id, answer: 'Seaweed' });
    assert.ok(!deleted.body.prompt.answers.some(x => x.answer === 'Seaweed'));
    const tiny = (await a.admin('create-prompt', { text: 'Name one thing', category: 'likes' })).body.prompt;
    await a.admin('add-answer', { promptId: tiny.id, answer: 'Thing', tier: 'plankton' });
    await a.admin('enabled', { promptId: tiny.id, enabled: true });
    await bad('delete-answer', { promptId: tiny.id, answer: 'Thing' }, /last answer/);
    // Everything is in the audit log.
    const actions = (await a.admin('audit')).body.entries.map(e => e.action);
    for (const action of ['create_prompt', 'add_answer', 'enabled', 'edit_prompt', 'edit_answer', 'delete_answer']) assert.ok(actions.includes(action), action);
  });

  test(kind + ': re-seeding never undoes admin-page changes, even with --force', async () => {
    const h = await harness(kind), a = await h.admin();
    // On a prompt from the bank: edit the question, rename one answer, delete one, edit a quip, add one.
    await a.admin('edit-prompt', { promptId: 'media-shows', text: 'Name a show this chat will not stop arguing about' });
    await a.admin('edit-answer', { promptId: 'media-shows', answer: 'Seal Island', newAnswer: 'Seal Island (the remake)' });
    await a.admin('delete-answer', { promptId: 'media-shows', answer: 'Moon Lawyers' });
    await a.admin('edit-answer', { promptId: 'media-shows', answer: 'Tuesday Fog', quip: 'Bea has seen it four times' });
    await a.admin('add-answer', { promptId: 'media-shows', answer: 'Ferry Tales', tier: 'rare' });
    await a.admin('create-prompt', { text: 'Name a made-up thing', category: 'media' });
    let plan = planSeed(FIXTURE_BANK, await h.store.adminPrompts());
    assert.deepEqual(plan.changed, [], 'the same bank sees no changes');
    // A newer bank with a real change (a weight), forced through: admin changes all survive.
    const bank = structuredClone(FIXTURE_BANK);
    bank.prompts.find(p => p.id === 'media-shows').answers.find(x => x.answer === 'Bake Off').weight = 99;
    bank.prompts.push({ id: 'name-a-made-up-thing', text: 'A bank prompt with the same id', category: 'media', answers: [{ answer: 'x', tier: 'plankton' }] });
    plan = planSeed(bank, await h.store.adminPrompts(), { force: true });
    assert.deepEqual(plan.changed.map(c => c.id), ['media-shows']); assert.deepEqual(plan.conflicts, ['name-a-made-up-thing']);
    const row = plan.updates.find(u => u.id === 'media-shows').row, names = row.answers.map(x => x.answer);
    assert.equal(row.text, 'Name a show this chat will not stop arguing about');
    assert.ok(names.includes('Seal Island (the remake)') && !names.includes('Seal Island'), 'rename kept');
    assert.ok(!names.includes('Moon Lawyers'), 'deleted answer not re-added');
    assert.ok(names.includes('Ferry Tales'), 'added answer kept');
    assert.equal(row.answers.find(x => x.answer === 'Tuesday Fog').quip, 'Bea has seen it four times');
    assert.equal(row.answers.find(x => x.answer === 'Bake Off').weight, 99, 'the bank change does apply');
  });

  test(kind + ': /admin arrives already showing the right view (no flash)', async () => {
    const h = await harness(kind), out = h.browser(), page = (await out.raw('/admin')).text;
    assert.match(page, /data-signed-in="false"/); assert.match(page, /id="login-view" class="admin-login">/); assert.match(page, /id="admin-bar" hidden>/, 'no admin bar before signing in'); assert.match(page, /id="editor-view" class="admin-editor" hidden>/);
    const a = await h.admin(), inside = (await a.raw('/admin')).text;
    assert.match(inside, /data-signed-in="true"/); assert.match(inside, /id="login-view" class="admin-login" hidden>/); assert.match(inside, /id="editor-view" class="admin-editor">/);
    for (const p of FIXTURE_BANK.prompts) assert.ok(!inside.includes(p.text), 'still no prompt data in the HTML');
  });
}
