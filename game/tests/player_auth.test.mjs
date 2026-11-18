// Player password, sessions, lockouts, CSRF and pick-your-name. Made-up passwords only.
// Every test runs against both stores (in-memory, and Supabase on PGlite with the real migrations).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, browser, MEMBERS, FIXTURE_BANK, TEST_PASSWORD, ORIGIN } from './helpers/app.mjs';
import { hashPassword, verifyPassword, parseHash, sha256hex, timingSafeEqual } from '../src/auth.mjs';
import { ipLockedUntil, globalLockedUntil, LIMITS } from '../src/lockout.mjs';

const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const GAME_ROUTES = [['GET', '/api/today'], ['GET', '/api/state?run=00000000-0000-4000-8000-000000000001'], ['GET', '/api/review?run=00000000-0000-4000-8000-000000000001'], ['GET', '/api/members'],
  ['POST', '/api/start'], ['POST', '/api/answer'], ['POST', '/api/next'], ['POST', '/api/pause'], ['POST', '/api/member'], ['POST', '/api/logout']];

// Counts PBKDF2 derivations, to show every login attempt does the same work.
function countDerivations() {
  const subtle = Object.getPrototypeOf(crypto.subtle), original = subtle.deriveBits;
  const counter = { n: 0, restore: () => { subtle.deriveBits = original; } };
  subtle.deriveBits = function (...args) { counter.n++; return original.apply(this, args); };
  return counter;
}

test('password hashing: format, minimum length, verify, malformed hashes', async () => {
  const hash = await hashPassword('another made-up passphrase');
  assert.match(hash, /^pbkdf2\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(hash, await hashPassword('another made-up passphrase'), 'random salt');
  await assert.rejects(hashPassword('elevenchars'), /at least 12/);
  assert.equal(await verifyPassword('another made-up passphrase', hash), true);
  assert.equal(await verifyPassword('another made-up passphrasE', hash), false);
  for (const bad of [undefined, '', 'pbkdf2$100000$abc$def', 'pbkdf2$999999$' + hash.split('$')[2] + '$' + hash.split('$')[3], 'sha1$x$y$z']) {
    assert.equal(parseHash(bad), null);
    assert.equal(await verifyPassword('another made-up passphrase', bad), false);
  }
  assert.equal(timingSafeEqual('abc', 'abc'), true); assert.equal(timingSafeEqual('abc', 'abd'), false); assert.equal(timingSafeEqual('abc', 'abcd'), false);
});

test('lockout rules: doubling per IP up to 24 h, reset by a success; global 50 per hour', () => {
  const fails = (start, n, gap = 1000) => Array.from({ length: n }, (_, i) => ({ at: start + i * gap, success: false }));
  let attempts = fails(0, 5);
  assert.equal(ipLockedUntil(attempts), 4000 + 15 * MIN);
  attempts = [...attempts, ...fails(4000 + 15 * MIN + 1, 5)];
  assert.equal(ipLockedUntil(attempts), attempts.at(-1).at + 30 * MIN, 'second lockout doubles');
  let t = 0; attempts = [];
  for (let i = 0; i < 10; i++) { attempts.push(...fails(t, 5)); t = ipLockedUntil(attempts) + 1; }
  assert.equal(ipLockedUntil(attempts) - attempts.at(-1).at, LIMITS.maxLock, 'capped at 24 hours');
  attempts.push({ at: t, success: true }, ...fails(t + 1, 5));
  assert.equal(ipLockedUntil(attempts) - attempts.at(-1).at, 15 * MIN, 'a success resets the doubling');
  assert.equal(ipLockedUntil(fails(0, 4)), 0);
  assert.equal(ipLockedUntil([...fails(0, 4), ...fails(16 * MIN, 1)]), 0, 'failures more than 15 minutes apart don\'t add up');
  assert.equal(globalLockedUntil(Array.from({ length: 49 }, (_, i) => i * 1000)), 0);
  assert.equal(globalLockedUntil(Array.from({ length: 50 }, (_, i) => i * 1000)), 49000 + HOUR);
});

for (const kind of ['memory', 'supabase']) {
  test(kind + ': without a session there is only the password screen; game routes return 401 with no data', async () => {
    const h = await harness(kind), b = h.browser();
    const page = await b.raw('/');
    assert.equal(page.status, 200); assert.match(page.text, /id="login-form"/); assert.match(page.text, /MIZERILLION|Mizerillion/);
    assert.doesNotMatch(page.text, /app\.mjs|member-list|prompt-text/);
    for (const m of MEMBERS) assert.ok(!page.text.includes(m.display_name), 'no member names');
    for (const p of FIXTURE_BANK.prompts) assert.ok(!page.text.includes(p.text), 'no prompts');
    assert.deepEqual((await b.call('/api/session')).body, { authenticated: false });
    for (const [method, path] of GAME_ROUTES) {
      const r = method === 'GET' ? await b.call(path) : await b.raw(path, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Origin: ORIGIN } });
      assert.equal(r.status, 401, `${method} ${path}`); assert.deepEqual(r.body, { error: 'Members only.' });
    }
    // A made-up cookie doesn't count either.
    b.jar.set('__Host-play', 'x'.repeat(43));
    assert.equal((await b.call('/api/today')).status, 401);
    assert.match((await b.raw('/')).text, /id="login-form"/);
  });

  test(kind + ': wrong, empty and malformed passwords all get the same "Wrong password", with the same work done', async () => {
    const h = await harness(kind), b = h.browser(), counter = countDerivations();
    try {
      const bodies = [JSON.stringify({ password: 'definitely-not-it' }), JSON.stringify({ password: '' }), JSON.stringify({ password: 12345 }),
        JSON.stringify({ password: null }), JSON.stringify({}), JSON.stringify({ password: 'x'.repeat(2000) }), 'not json at all', JSON.stringify([1, 2])];
      for (const body of bodies) {
        const r = await b.raw('/api/login', { method: 'POST', body, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '198.51.100.' + bodies.indexOf(body) } });
        assert.equal(r.status, 401, body); assert.deepEqual(r.body, { error: 'Wrong password' }); assert.equal(r.setCookie, null);
      }
      assert.equal(counter.n, bodies.length, 'one full PBKDF2 per attempt, whatever the input');
      // A missing or broken hash secret is just as generic.
      h.env.PLAYER_PASSWORD_HASH = 'not-a-hash';
      const r = await b.login(TEST_PASSWORD);
      assert.equal(r.status, 401); assert.deepEqual(r.body, { error: 'Wrong password' }); assert.equal(counter.n, bodies.length + 1);
    } finally { counter.restore(); }
  });

  test(kind + ': the right password sets a __Host-play cookie; only its hash is stored; the token is never in a body', async () => {
    const h = await harness(kind), b = h.browser();
    const r = await b.login();
    assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true });
    const m = /^__Host-play=([A-Za-z0-9_-]{43}); HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/.exec(r.setCookie);
    assert.ok(m, r.setCookie);
    const token = m[1], stored = await h.store.getSession('player', await sha256hex(token));
    assert.ok(stored, 'the session is stored under the token hash'); assert.equal(stored.token_hash, await sha256hex(token));
    assert.ok(!JSON.stringify(stored).includes(token), 'the token itself is not stored');
    const s = await b.call('/api/session');
    assert.equal(s.body.authenticated, true); assert.equal(s.body.member, null); assert.match(s.body.csrf, /^[0-9a-f]{43}$/);
    const page = await b.raw('/'); assert.match(page.text, /id="who-dialog"/); assert.doesNotMatch(page.text, /id="login-form"/);
    // Over plain http (local dev) the cookie is play_dev, without Secure.
    const local = browser(h.app, h.env, { base: 'http://localhost:8787', origin: 'http://localhost:8787' });
    assert.match((await local.login()).setCookie, /^play_dev=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    // Play a little, then check no response anywhere carried the token.
    await b.call('/api/member', { memberId: MEMBERS[0].id }); await b.call('/api/start', {}); await b.call('/api/today');
    assert.ok(b.seen.every(text => !text.includes(token)), 'token never appears in a response body');
  });

  test(kind + ': pick your name: list after login, game needs a name, switch, hidden members', async () => {
    const h = await harness(kind), b = h.browser();
    await b.login();
    const list = (await b.call('/api/members')).body.members;
    assert.deepEqual(list.map(m => m.name), MEMBERS.map(m => m.display_name).sort());
    const r = await b.call('/api/start', {});
    assert.equal(r.status, 409); assert.equal(r.body.needMember, true);
    assert.equal((await b.call('/api/member', { memberId: 'not-a-uuid' })).status, 400);
    assert.equal((await b.call('/api/member', { memberId: '00000000-0000-4000-8000-0000000000ff' })).status, 400);
    const picked = await b.call('/api/member', { memberId: MEMBERS[1].id });
    assert.deepEqual(picked.body.member, { id: MEMBERS[1].id, name: MEMBERS[1].display_name });
    assert.equal((await b.call('/api/today')).body.member.name, MEMBERS[1].display_name);
    assert.equal((await b.call('/api/start', {})).status, 200);
    // Not you? Switch: the session stays, the name is forgotten.
    assert.equal((await b.call('/api/member', { memberId: null })).body.member, null);
    assert.equal((await b.call('/api/today')).status, 409);
    assert.equal((await b.call('/api/session')).body.authenticated, true);
    // A hidden member can't be picked, and a session holding one must pick again.
    await b.call('/api/member', { memberId: MEMBERS[2].id });
    if (kind === 'memory') h.store.members.get(MEMBERS[2].id).active = false;
    else await h.pg.query('update members set active = false where id = $1', [MEMBERS[2].id]);
    h.clock.t += 31e3; // past the 30 s session cache
    assert.equal((await b.call('/api/today')).status, 409);
    assert.equal((await b.call('/api/member', { memberId: MEMBERS[2].id })).status, 400);
    assert.ok(!(await b.call('/api/members')).body.members.some(m => m.id === MEMBERS[2].id));
  });

  test(kind + ': one daily dive per member, even from two devices', async () => {
    const h = await harness(kind);
    const phone = await h.player({ name: 'Avery' }), laptop = await h.player({ name: 'Avery' }), other = await h.player({ name: 'Bea' });
    const a = (await phone.call('/api/start', {})).body, b = (await laptop.call('/api/start', {})).body, c = (await other.call('/api/start', {})).body;
    assert.equal(a.runId, b.runId); assert.notEqual(a.runId, c.runId);
  });

  test(kind + ': per-IP lockout: 5 failures lock 15 min, then 30; other IPs and successes elsewhere are separate', async () => {
    const h = await harness(kind), attacker = h.browser({ ip: '192.0.2.66' }), friend = h.browser({ ip: '192.0.2.10' });
    for (let i = 0; i < 5; i++) assert.equal((await attacker.login('wrong-guess-' + i)).status, 401);
    const locked = await attacker.login(); // even the right password
    assert.equal(locked.status, 429); assert.match(locked.body.error, /Too many attempts\. Try again in 15 minutes\./); assert.ok(Number(locked.headers.get('Retry-After')) > 0);
    assert.equal((await friend.login()).status, 200, 'another IP is unaffected');
    assert.equal((await attacker.login()).status, 429, "a success from another IP doesn't unlock this one");
    h.clock.t += 15 * MIN + 1000;
    for (let i = 0; i < 5; i++) assert.equal((await attacker.login('wrong-again-' + i)).status, 401);
    h.clock.t += 16 * MIN;
    assert.equal((await attacker.login()).status, 429, 'second lockout lasts 30 minutes');
    h.clock.t += 15 * MIN;
    assert.equal((await attacker.login()).status, 200);
  });

  test(kind + ': global lockout: 50 failures in an hour from anywhere disables login for an hour', async () => {
    const h = await harness(kind);
    for (let i = 0; i < 50; i++) { assert.equal((await h.browser({ ip: `10.0.${i >> 8}.${i & 255}` }).login('spray-' + i)).status, 401); h.clock.t += 1000; }
    const fresh = h.browser({ ip: '172.16.0.1' });
    assert.equal((await fresh.login()).status, 429, 'even a new IP with the right password');
    h.clock.t += 59 * MIN;
    assert.equal((await fresh.login()).status, 429);
    h.clock.t += 2 * MIN;
    assert.equal((await fresh.login()).status, 200);
  });

  test(kind + ': sessions expire after 30 days, end on logout, and end when the password hash changes', async () => {
    const h = await harness(kind);
    const expiring = await h.player();
    h.clock.t += 30 * DAY - 1000; assert.equal((await expiring.call('/api/today')).status, 200);
    h.clock.t += 2000; assert.equal((await expiring.call('/api/today')).status, 401, 'expired');
    assert.match((await expiring.raw('/')).text, /id="login-form"/);

    const leaving = await h.player();
    const out = await leaving.call('/api/logout', {});
    assert.equal(out.status, 200); assert.match(out.setCookie, /^__Host-play=; .*Max-Age=0$/, 'the cookie is cleared');
    assert.equal((await leaving.call('/api/today')).status, 401, 'logged out');

    const steady = await h.player();
    assert.equal((await steady.call('/api/today')).status, 200);
    h.env.PLAYER_PASSWORD_HASH = await hashPassword('a brand new made-up password');
    assert.equal((await steady.call('/api/today')).status, 401, 'rotating the hash logs everyone out');
    assert.equal((await h.browser().login(TEST_PASSWORD)).status, 401, 'the old password stops working');
    assert.equal((await h.browser({ ip: '192.0.2.99' }).login('a brand new made-up password')).status, 200);
  });

  test(kind + ': a logged-out session can\'t be reused', async () => {
    const h = await harness(kind), p = await h.player(), token = p.jar.get('__Host-play');
    await p.call('/api/logout', {});
    p.jar.set('__Host-play', token); // replay the old cookie
    assert.equal((await p.call('/api/today')).status, 401);
    assert.deepEqual((await p.call('/api/session')).body, { authenticated: false });
  });

  test(kind + ': CSRF and Origin: every change needs this site\'s Origin and the session\'s token', async () => {
    const h = await harness(kind), p = await h.player();
    const post = (path, headers) => p.raw(path, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', ...headers } });
    assert.equal((await post('/api/start', { 'X-CSRF-Token': p.csrf })).status, 403, 'no Origin');
    assert.equal((await post('/api/start', { Origin: 'https://evil.example', 'X-CSRF-Token': p.csrf })).status, 403, 'wrong Origin');
    assert.equal((await post('/api/start', { Origin: ORIGIN })).status, 403, 'no token');
    assert.equal((await post('/api/start', { Origin: ORIGIN, 'X-CSRF-Token': p.csrf.replace(/.$/, c => c === '0' ? '1' : '0') })).status, 403, 'wrong token');
    const other = await h.player();
    assert.equal((await post('/api/start', { Origin: ORIGIN, 'X-CSRF-Token': other.csrf })).status, 403, "another session's token");
    assert.equal((await post('/api/logout', { Origin: ORIGIN })).status, 403, 'logout needs the token too');
    assert.equal((await p.raw('/api/login', { method: 'POST', body: JSON.stringify({ password: TEST_PASSWORD }), headers: { 'Content-Type': 'application/json' } })).status, 403, 'login needs the Origin');
    assert.equal((await post('/api/start', { Origin: ORIGIN, 'X-CSRF-Token': p.csrf })).status, 200);
    assert.equal((await p.call('/api/today')).status, 200, 'reads need no token');
  });

  test(kind + ': security headers on pages, assets and API responses', async () => {
    const h = await harness(kind), b = h.browser();
    for (const path of ['/', '/api/session', '/style.css']) {
      const r = await b.raw(path), csp = r.headers.get('Content-Security-Policy');
      assert.match(csp, /script-src 'self'/); assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/); assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff'); assert.equal(r.headers.get('Referrer-Policy'), 'same-origin');
      assert.match(r.headers.get('Strict-Transport-Security'), /max-age=\d+/);
    }
    assert.equal((await b.raw('/api/session')).headers.get('Cache-Control'), 'no-store');
    assert.equal((await b.raw('/')).headers.get('Cache-Control'), 'no-store');
  });
}
