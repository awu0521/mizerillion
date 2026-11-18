#!/usr/bin/env node
// Upserts the prompt bank into Supabase. Runs locally only; the bank never goes through GitHub.
//
//   node scripts/seed_prompts.mjs [path] [--force] [--dry-run]
//
// path defaults to ../bank_generation/data/prompt_bank.json. Reads SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY from the environment or game/.dev.vars.
// - Tier edits made in Supabase are kept. Aliases added in Supabase are kept.
// - If an existing prompt's answers or text changed, prints a diff and stops unless --force.
// - Never writes `enabled` on an existing prompt. New prompts with review: true start disabled.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, GAME_DIR } from './lib/env.mjs';
import { validateBank, planSeed } from './lib/seed_plan.mjs';
import { supabaseClient } from '../src/store/supabase.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force'), dryRun = args.includes('--dry-run');
const unknown = args.filter(a => a.startsWith('--') && !['--force', '--dry-run'].includes(a));
if (unknown.length) { console.error(`Unknown option ${unknown.join(', ')}`); process.exit(2); }
const path = resolve(process.cwd(), args.find(a => !a.startsWith('--')) || resolve(GAME_DIR, '../bank_generation/data/prompt_bank.json'));

let bank;
try { bank = JSON.parse(readFileSync(path, 'utf8')); }
catch (e) { console.error(`Could not read ${path}: ${e.message}`); process.exit(1); }
const { errors, warnings } = validateBank(bank);
if (errors.length) { console.error(`${path} is not a valid prompt bank:\n- ${errors.join('\n- ')}`); process.exit(1); }
for (const w of warnings) console.warn('warning: ' + w);

let env;
try { env = loadEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']); }
catch (e) { console.error(e.message); process.exit(1); }
const db = supabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: existing, error } = await db.from('prompts').select('id,text,category,note,answers,needs_review');
if (error) { console.error('Could not read prompts from Supabase: ' + error.message); process.exit(1); }

const plan = planSeed(bank, existing, { force });
console.log(`Bank: ${bank.prompts.length} prompts from ${path}`);
console.log(`  new: ${plan.inserts.length} (${plan.inserts.filter(r => !r.enabled).length} start disabled for review)`);
console.log(`  unchanged: ${plan.unchanged.length}`);
console.log(`  changed: ${plan.changed.length}`);
if (plan.onlyInDatabase.length) console.log(`  in Supabase but not in this bank (left alone): ${plan.onlyInDatabase.join(', ')}`);
for (const c of plan.changed) console.log(`\n${c.id}\n${c.diff.join('\n')}`);
if (plan.changed.length && !force) {
  console.log('\nSome prompts changed. Nothing was written. Re-run with --force to apply these changes.');
  console.log('(Tiers and aliases edited in Supabase are kept either way; answers removed from the bank are removed.)');
  process.exit(1);
}
if (dryRun) { console.log('\n--dry-run: nothing was written.'); process.exit(0); }

if (plan.inserts.length) {
  const { error: e } = await db.from('prompts').insert(plan.inserts);
  if (e) { console.error('Insert failed: ' + e.message); process.exit(1); }
}
for (const { id, row } of plan.updates) {
  const { error: e } = await db.from('prompts').update(row).eq('id', id);
  if (e) { console.error(`Update of ${id} failed: ${e.message}`); process.exit(1); }
}
console.log(`\nDone: inserted ${plan.inserts.length}, updated ${plan.updates.length}.`);
