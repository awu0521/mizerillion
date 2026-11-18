#!/usr/bin/env node
// Checks a password against the hashes in game/.dev.vars, without printing or storing anything.
// Use it to find out which password a hash belongs to before sending it to Cloudflare.
//
//   node scripts/check_password.mjs
import { readFileSync, existsSync } from 'node:fs';
import { GAME_DIR, parseDevVars } from './lib/env.mjs';
import { verifyPassword, parseHash } from '../src/auth.mjs';
import { askHidden, readPipedLine } from './lib/hidden_input.mjs';

if (!existsSync(GAME_DIR + '.dev.vars')) { console.error('game/.dev.vars not found.'); process.exit(1); }
const vars = parseDevVars(readFileSync(GAME_DIR + '.dev.vars', 'utf8'));
try {
  const password = process.stdin.isTTY ? await askHidden('Password to check (nothing shows): ') : await readPipedLine();
  if (password !== password.trim()) console.log('Note: what you typed starts or ends with a space. Spaces count.');
  let any = false;
  for (const name of ['PLAYER_PASSWORD_HASH', 'ADMIN_PASSWORD_HASH']) {
    if (!parseHash(vars[name])) { console.log(`${name}: not set or not a valid hash in .dev.vars`); continue; }
    const ok = await verifyPassword(password, vars[name]);
    any ||= ok;
    console.log(`${name}: ${ok ? 'MATCHES' : 'does not match'}`);
  }
  if (!any) console.log('\nNeither hash in .dev.vars is for this password. Make a new one with node scripts/hash_password.mjs.');
} catch (e) { console.error(e.message); process.exit(1); }
