// Shared test setup: a store (in-memory, or Supabase on PGlite with the real migrations), the Worker
// app with a fake clock, and HTTPS "browsers" that log in with a MADE-UP password and pick a name.
// No real chat data or real password is used anywhere in the tests.
import { readFileSync } from 'node:fs';
import { createApp } from '../../src/worker.mjs';
import { MemoryStore } from '../../src/store/memory.mjs';
import { SupabaseStore } from '../../src/store/supabase.mjs';
import { hashPassword } from '../../src/auth.mjs';
import { planSeed } from '../../scripts/lib/seed_plan.mjs';
import { createTestDatabase, fakeSupabase } from './pg_supabase.mjs';

export const FIXTURE_BANK = JSON.parse(readFileSync(new URL('../../fixtures/sample_bank.json', import.meta.url), 'utf8'));
export const MEMBERS = JSON.parse(readFileSync(new URL('../../fixtures/sample_members.json', import.meta.url), 'utf8'));
export const TEST_PASSWORD = 'made-up-test-password-1';
export const TEST_HASH = await hashPassword(TEST_PASSWORD);
export const TEST_ADMIN_PASSWORD = 'made-up-admin-password-9';
export const TEST_ADMIN_HASH = await hashPassword(TEST_ADMIN_PASSWORD);
export const ORIGIN = 'https://mizerillion.test';
export const START = Date.parse('2026-11-20T18:00:00Z'); // 10:00 in Vancouver

export async function makeStore(kind, bank = FIXTURE_BANK) {
  if (kind === 'memory') { const store = new MemoryStore({ bank, members: MEMBERS }); return { store, guesses: async () => store.guesses }; }
  const pg = await createTestDatabase(), db = fakeSupabase(pg);
  for (const [table, rows] of [['prompts', planSeed(bank, []).inserts], ['members', MEMBERS]]) {
    const { error } = await db.from(table).insert(rows); if (error) throw new Error(error.message);
  }
  return { store: new SupabaseStore(db), pg, guesses: async () => (await pg.query('select * from guess_log order by id')).rows };
}

/** An app + clock + env, and a factory for browsers. */
export async function harness(kind, { bank } = {}) {
  const made = await makeStore(kind, bank), clock = { t: START };
  const app = createApp({ store: made.store, now: () => clock.t });
  const env = { PLAYER_PASSWORD_HASH: TEST_HASH, ADMIN_PASSWORD_HASH: TEST_ADMIN_HASH, ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };
  let next = 0;
  const h = {
    ...made, clock, app, env,
    /** A browser with no session. */
    browser: opts => browser(app, env, opts),
    /** A browser signed in as admin. */
    async admin(opts) { const b = browser(app, env, opts), r = await b.adminLogin(); if (r.status !== 200) throw new Error('admin login failed: ' + r.text); return b; },
    /** A browser that has logged in and picked the next member's name. */
    async player({ name } = {}) {
      const b = browser(app, env);
      const login = await b.login(); if (login.status !== 200) throw new Error('login failed: ' + login.text);
      const member = name ? MEMBERS.find(m => m.display_name === name) : MEMBERS[next++ % MEMBERS.length];
      const r = await b.call('/api/member', { memberId: member.id }); if (r.status !== 200) throw new Error('pick failed: ' + r.text);
      b.member = member;
      return b;
    },
  };
  return h;
}

/** A cookie-keeping browser. Every response body is kept in `seen` so tests can check what leaked. */
export function browser(app, env, { ip = '203.0.113.7', origin = ORIGIN, base = ORIGIN } = {}) {
  const jar = new Map(), seen = [];
  let csrf = '', adminCsrf = '';
  const b = {
    seen, jar,
    async raw(path, init = {}) {
      const headers = new Headers(init.headers || {});
      if (jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', ip);
      const r = await app.fetch(new Request(base + path, { ...init, headers }), env);
      const setCookie = r.headers.get('Set-Cookie');
      if (setCookie) { const [pair] = setCookie.split(';'), i = pair.indexOf('='); const k = pair.slice(0, i), v = pair.slice(i + 1); if (/Max-Age=0\b/.test(setCookie)) jar.delete(k); else jar.set(k, v); }
      const text = await r.text(); seen.push(text);
      let body = null; try { body = JSON.parse(text); } catch { /* HTML */ }
      return { status: r.status, body, text, headers: r.headers, setCookie };
    },
    /** GET without data; POST with JSON, this site's Origin and the CSRF token. */
    call(path, data, headers = {}) {
      if (data === undefined) return b.raw(path, { headers });
      return b.raw(path, { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': csrf, ...headers } });
    },
    async login(password = TEST_PASSWORD) {
      const r = await b.raw('/api/login', { method: 'POST', body: JSON.stringify({ password }), headers: { 'Content-Type': 'application/json', Origin: origin } });
      if (r.status === 200) csrf = (await b.call('/api/session')).body.csrf;
      return r;
    },
    get csrf() { return csrf; },
    get adminCsrf() { return adminCsrf; },
    async adminLogin(password = TEST_ADMIN_PASSWORD) {
      const r = await b.raw('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }), headers: { 'Content-Type': 'application/json', Origin: origin } });
      if (r.status === 200) adminCsrf = (await b.raw('/api/admin/session')).body.csrf;
      return r;
    },
    /** Admin API: GET without data; POST with Origin and the admin CSRF token. */
    admin(path, data, headers = {}) {
      if (data === undefined) return b.raw('/api/admin/' + path, { headers });
      return b.raw('/api/admin/' + path, { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': adminCsrf, ...headers } });
    },
  };
  return b;
}
