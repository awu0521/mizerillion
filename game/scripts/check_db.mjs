#!/usr/bin/env node
// Checks that every migration in supabase/migrations has been run on the Supabase project in
// .dev.vars (read-only). `npm run deploy` runs this first, because new code needs new columns.
//
//   npm run check:db
import { readdirSync } from 'node:fs';
import { loadEnv, serviceKeyProblem, GAME_DIR } from './lib/env.mjs';
import { supabaseClient } from '../src/store/supabase.mjs';

// One thing each migration adds; if it's there, that migration has run.
const MARKERS = {
  '20261118000000_game_schema.sql': ['prompts', 'id'],
  '20261118010000_service_role_grants.sql': ['members', 'id'],
  '20261118020000_player_auth.sql': ['player_sessions', 'token_hash'],
  '20261118030000_admin.sql': ['prompts', 'version'],
  '20261118040000_admin_editing.sql': ['prompts', 'created_by_admin,text_edited,removed_answers'],
  '20261118050000_settings.sql': ['settings', 'key,value'],
};

const files = readdirSync(GAME_DIR + 'supabase/migrations').filter(f => f.endsWith('.sql')).sort();
const unknown = files.filter(f => !MARKERS[f]);
if (unknown.length) { console.error(`check_db.mjs doesn't know how to check: ${unknown.join(', ')} (add it to MARKERS).`); process.exit(1); }

let env;
try { env = loadEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']); } catch (e) { console.error(e.message); process.exit(1); }
if (serviceKeyProblem(env.SUPABASE_SERVICE_ROLE_KEY)) { console.error(serviceKeyProblem(env.SUPABASE_SERVICE_ROLE_KEY)); process.exit(1); }
const db = supabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const missing = [];
for (const file of files) {
  const [table, columns] = MARKERS[file];
  const { error } = await db.from(table).select(columns).limit(1);
  console.log(`${error ? 'MISSING' : 'ok     '} ${file}`);
  if (error) missing.push(file);
}
if (missing.length) {
  console.error(`\nRun ${missing.length === 1 ? 'this file' : 'these files, in this order,'} in Supabase (SQL Editor → New query → paste → Run):\n  ${missing.map(f => 'supabase/migrations/' + f).join('\n  ')}`);
  process.exit(1);
}
console.log('All migrations have been run.');
