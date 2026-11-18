#!/usr/bin/env node
// Hashes a password for PLAYER_PASSWORD_HASH or ADMIN_PASSWORD_HASH. The password is typed without
// echo and never stored or printed; only the hash is printed (to stdout).
//
//   node scripts/hash_password.mjs
//   npx wrangler secret put PLAYER_PASSWORD_HASH     # paste the printed hash
//
// For local dev, also put it in game/.dev.vars:  PLAYER_PASSWORD_HASH=pbkdf2$100000$...
// Piped input (not a terminal) reads one line and skips the confirmation.
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth.mjs';
import { askHidden, readPipedLine } from './lib/hidden_input.mjs';

try {
  let password;
  if (process.stdin.isTTY) {
    console.error(`Password (at least ${MIN_PASSWORD_LENGTH} characters; nothing shows as you type).`);
    password = await askHidden('Password: ');
    if (Array.from(password).length < MIN_PASSWORD_LENGTH) throw new Error(`Too short: use at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (await askHidden('Again:    ') !== password) throw new Error("The two entries don't match. Nothing was printed.");
  } else password = await readPipedLine();
  const hash = await hashPassword(password);
  console.error('\nHash (safe to store; it is not the password):');
  console.log(hash);
  console.error('\nNext:\n  npx wrangler secret put PLAYER_PASSWORD_HASH   (or ADMIN_PASSWORD_HASH), then paste the hash\n  and for local dev add a line to game/.dev.vars:  PLAYER_PASSWORD_HASH=<the hash>');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
