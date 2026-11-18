#!/usr/bin/env node
// `npm run dev`: asks which data to play with, then starts `wrangler dev` on http://localhost:8787.
//   npm run dev            -> asks
//   npm run dev -- bank    -> your real prompt_bank.json, in memory (no database)
//   npm run dev -- fixture -> the fake test bank, in memory
//   npm run dev -- supabase
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { GAME_DIR, parseDevVars } from './lib/env.mjs';

const BANK_FILE = GAME_DIR + '../bank_generation/data/prompt_bank.json';
const CHOICES = [
  { key: 'bank', label: 'Your real prompt bank (in memory, no database)', config: 'wrangler.bank.jsonc', ok: () => existsSync(BANK_FILE) || 'bank_generation/data/prompt_bank.json not found. Generate it first (see bank_generation/README.md).' },
  { key: 'fixture', label: 'Fake test bank (in memory, no database)', config: 'wrangler.fixture.jsonc', ok: () => true },
  { key: 'supabase', label: 'Supabase (whatever you last seeded)', config: 'wrangler.jsonc', ok: () => existsSync(GAME_DIR + '.dev.vars') || 'game/.dev.vars not found. Set up Supabase first (see game/README.md, step 2).' },
];

async function ask() {
  console.log('Which prompts do you want to play with?');
  CHOICES.forEach((c, i) => console.log(`  ${i + 1}) ${c.label}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question('Choose 1-3 [1]: ')).trim().toLowerCase() || '1';
      const choice = CHOICES[Number(answer) - 1] || CHOICES.find(c => c.key === answer);
      if (choice) return choice;
      console.log('Type 1, 2 or 3.');
    }
  } finally { rl.close(); }
}

const arg = process.argv[2]?.toLowerCase();
let choice = arg ? CHOICES.find(c => c.key === arg) : null;
if (arg && !choice) { console.error(`Unknown option "${process.argv[2]}". Use one of: ${CHOICES.map(c => c.key).join(', ')}.`); process.exit(2); }
// Without a terminal to ask (e.g. a script), default to the fake bank.
if (!choice) choice = process.stdin.isTTY ? await ask() : CHOICES[1];
const ok = choice.ok();
if (ok !== true) { console.error(ok); process.exit(1); }
// Every mode needs the player password hash, or nobody can get past the password screen.
const vars = existsSync(GAME_DIR + '.dev.vars') ? parseDevVars(readFileSync(GAME_DIR + '.dev.vars', 'utf8')) : {};
if (!vars.PLAYER_PASSWORD_HASH) {
  console.error('game/.dev.vars has no PLAYER_PASSWORD_HASH, so nobody could log in. Make one:\n  node scripts/hash_password.mjs\nthen add this line to game/.dev.vars:\n  PLAYER_PASSWORD_HASH=<the printed hash>');
  process.exit(1);
}

console.log(`\nStarting with: ${choice.label}\n`);
const child = spawn(GAME_DIR + 'node_modules/.bin/wrangler', ['dev', '--port', '8787', '-c', choice.config], { cwd: GAME_DIR, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
