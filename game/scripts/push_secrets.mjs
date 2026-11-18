#!/usr/bin/env node
// Copies the Worker's secrets from game/.dev.vars to Cloudflare with `wrangler secret put`.
// Shows only the names, asks before sending, and never prints a value.
//
//   npm run secrets                      all four
//   npm run secrets -- PLAYER_PASSWORD_HASH   just one
//
// To use different production passwords than local ones, run `node scripts/hash_password.mjs` and
// `npx wrangler secret put PLAYER_PASSWORD_HASH` (or ADMIN_PASSWORD_HASH) yourself instead.
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { GAME_DIR, parseDevVars, serviceKeyProblem } from './lib/env.mjs';
import { parseHash } from '../src/auth.mjs';

const NAMES = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PLAYER_PASSWORD_HASH', 'ADMIN_PASSWORD_HASH'];
const wanted = process.argv.slice(2);
const bad = wanted.filter(n => !NAMES.includes(n));
if (bad.length) { console.error(`Unknown secret ${bad.join(', ')}. Choose from: ${NAMES.join(', ')}`); process.exit(2); }
const names = wanted.length ? wanted : NAMES;

if (!existsSync(GAME_DIR + '.dev.vars')) { console.error('game/.dev.vars not found.'); process.exit(1); }
const vars = parseDevVars(readFileSync(GAME_DIR + '.dev.vars', 'utf8'));
const problems = [];
for (const n of names) {
  const v = vars[n];
  if (!v) problems.push(`${n} is missing from .dev.vars`);
  else if (n.endsWith('_PASSWORD_HASH') && !parseHash(v)) problems.push(`${n} doesn't look like a hash from scripts/hash_password.mjs`);
  else if (n === 'SUPABASE_URL' && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(v)) problems.push('SUPABASE_URL should look like https://<project>.supabase.co');
  else if (n === 'SUPABASE_SERVICE_ROLE_KEY' && serviceKeyProblem(v)) problems.push(serviceKeyProblem(v));
}
if (names.includes('PLAYER_PASSWORD_HASH') && names.includes('ADMIN_PASSWORD_HASH') && vars.PLAYER_PASSWORD_HASH && vars.PLAYER_PASSWORD_HASH === vars.ADMIN_PASSWORD_HASH) problems.push('PLAYER_PASSWORD_HASH and ADMIN_PASSWORD_HASH are the same; use different passwords');
if (problems.length) { console.error('Not sending anything:\n- ' + problems.join('\n- ')); process.exit(1); }

console.log(`This will set these secrets on the Cloudflare Worker in wrangler.jsonc:\n  ${names.join('\n  ')}`);
if (names.some(n => n.endsWith('_PASSWORD_HASH'))) console.log('(Changing a password hash logs everyone out of that kind of session.)');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('Send them? [y/N] ')).trim().toLowerCase();
rl.close();
if (answer !== 'y' && answer !== 'yes') { console.log('Nothing sent.'); process.exit(0); }

for (const n of names) {
  const code = await new Promise(resolve => {
    const child = spawn(GAME_DIR + 'node_modules/.bin/wrangler', ['secret', 'put', n, '-c', 'wrangler.jsonc'], { cwd: GAME_DIR, stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end(vars[n]);
    child.on('exit', resolve);
  });
  if (code !== 0) { console.error(`Setting ${n} failed (see above). Have you run "npx wrangler login" and "npm run deploy"?`); process.exit(1); }
}
console.log('Done. Secrets take effect straight away.');
