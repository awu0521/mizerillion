#!/usr/bin/env node
// Builds what `wrangler deploy` would upload (without uploading) and checks that neither the Worker
// bundle nor public/ contains prompt or answer text, from the fake fixture bank or the real bank.
// Prints counts only, never the text. Exits 1 if anything is found. `npm run deploy` runs this first.
import { readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GAME_DIR } from './lib/env.mjs';

const OUT = join(GAME_DIR, '.wrangler', 'bundle-check');
rmSync(OUT, { recursive: true, force: true });
execFileSync(join(GAME_DIR, 'node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--outdir', OUT, '-c', process.env.CHECK_CONFIG || 'wrangler.jsonc'], { cwd: GAME_DIR, stdio: ['ignore', 'ignore', 'inherit'] });

const files = [];
const walk = dir => { for (const f of readdirSync(dir)) { const p = join(dir, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
walk(OUT); walk(join(GAME_DIR, 'public'));
const text = files.filter(f => /\.(m?js|css|html|json|svg|txt|map)$/.test(f)).map(f => readFileSync(f, 'utf8')).join('\n');

// What a bundled bank would certainly contain: its questions, its quips, multi-word answers, and the
// shape of answer data ("answer": "...", "tier": ...). Single words are only reported: ordinary
// words such as "password" are answers in some prompts and also appear in code.
const strong = bank => bank.prompts.flatMap(p => [p.text, ...p.answers.flatMap(a => [a.quip, /\s/.test(a.answer) ? a.answer : null])]).filter(s => typeof s === 'string' && s.length >= 10);
const singleWords = bank => bank.prompts.flatMap(p => p.answers.map(a => a.answer)).filter(s => typeof s === 'string' && s.length >= 8 && !/\s/.test(s));
const DATA_SHAPE = /["']?answer["']?\s*:\s*["'][^"'\n]{1,120}["']\s*,\s*["']?(?:tier|aliases|weight)["']?\s*:/;
let failed = false;
if (DATA_SHAPE.test(text)) { console.log('answer data (an answer string followed by its tier/aliases/weight) found'); failed = true; }
for (const [label, path] of [['fake fixture bank', join(GAME_DIR, 'fixtures/sample_bank.json')], ['real prompt bank', join(GAME_DIR, '../bank_generation/data/prompt_bank.json')]]) {
  if (!existsSync(path)) { console.log(`${label}: not on this machine, skipped`); continue; }
  const bank = JSON.parse(readFileSync(path, 'utf8'));
  const list = [...new Set(strong(bank))], found = list.filter(s => text.includes(s)).length;
  const words = [...new Set(singleWords(bank))], wordHits = words.filter(s => text.includes(s)).length;
  console.log(`${label}: ${found} of ${list.length} questions, quips and multi-word answers found${wordHits ? ` (${wordHits} single-word answers also occur as ordinary words in the code; not a leak)` : ''}`);
  if (found) failed = true;
}
rmSync(OUT, { recursive: true, force: true });
if (failed) { console.error('Refusing to deploy: game data found in what would be uploaded.'); process.exit(1); }
console.log('OK: no prompt or answer text in what would be uploaded.');
