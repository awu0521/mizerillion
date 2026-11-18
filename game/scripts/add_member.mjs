#!/usr/bin/env node
// Manage the names players pick from after the shared password.
//
//   node scripts/add_member.mjs "Display Name"              add (or bring back a hidden name)
//   node scripts/add_member.mjs --deactivate "Display Name"  hide a name from the picker
//   node scripts/add_member.mjs --rename "Old Name" "New"    change how a name is shown (keeps their dives)
//   node scripts/add_member.mjs --list                       show everyone
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment or game/.dev.vars.
// Names are matched ignoring case. Hiding a name keeps its past dives and scores.
import { loadEnv, serviceKeyProblem } from './lib/env.mjs';
import { supabaseClient } from '../src/store/supabase.mjs';

const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--')), words = args.filter(a => !a.startsWith('--'));
const unknown = flags.filter(f => !['--deactivate', '--list', '--rename'].includes(f));
const usage = 'Usage: node scripts/add_member.mjs "Display Name" | --deactivate "Display Name" | --rename "Old" "New" | --list';
if (unknown.length || (!flags.includes('--list') && words.length !== (flags.includes('--rename') ? 2 : 1))) { console.error(unknown.length ? `Unknown option ${unknown.join(', ')}\n${usage}` : usage); process.exit(2); }

let env;
try { env = loadEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']); } catch (e) { console.error(e.message); process.exit(1); }
const keyProblem = serviceKeyProblem(env.SUPABASE_SERVICE_ROLE_KEY);
if (keyProblem) { console.error(keyProblem); process.exit(1); }
const db = supabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const die = (what, error) => { console.error(`${what}: ${error.message}`); process.exit(1); };

const { data: members, error } = await db.from('members').select('id,display_name,active').order('display_name');
if (error) die('Could not read members', error);

if (flags.includes('--list')) {
  if (!members.length) console.log('No members yet.');
  for (const m of members) console.log(`${m.active ? '  ' : '- '}${m.display_name}${m.active ? '' : '  (hidden)'}`);
  process.exit(0);
}

if (flags.includes('--rename')) {
  const [from, to] = words.map(w => w.trim().replace(/\s+/g, ' '));
  const old = members.find(m => m.display_name.toLowerCase() === from.toLowerCase());
  if (!old) { console.error(`No member called "${from}". Use --list to see names.`); process.exit(1); }
  if (!to || Array.from(to).length > 40) { console.error('Names must be 1 to 40 characters.'); process.exit(2); }
  if (members.some(m => m.id !== old.id && m.display_name.toLowerCase() === to.toLowerCase())) { console.error(`"${to}" is already taken.`); process.exit(1); }
  const { error: e } = await db.from('members').update({ display_name: to }).eq('id', old.id);
  if (e) die('Could not rename member', e);
  console.log(`Renamed "${old.display_name}" to "${to}".`);
  process.exit(0);
}

const name = words[0].trim().replace(/\s+/g, ' ');
if (!name || Array.from(name).length > 40) { console.error('Names must be 1 to 40 characters.'); process.exit(2); }
const existing = members.find(m => m.display_name.toLowerCase() === name.toLowerCase());

if (flags.includes('--deactivate')) {
  if (!existing) { console.error(`No member called "${name}". Use --list to see names.`); process.exit(1); }
  if (!existing.active) { console.log(`"${existing.display_name}" is already hidden.`); process.exit(0); }
  const { error: e } = await db.from('members').update({ active: false }).eq('id', existing.id);
  if (e) die('Could not hide member', e);
  console.log(`Hidden "${existing.display_name}". Their past dives stay; they can't be picked any more.`);
} else if (existing) {
  if (existing.active) { console.log(`"${existing.display_name}" is already a member.`); process.exit(0); }
  const { error: e } = await db.from('members').update({ active: true }).eq('id', existing.id);
  if (e) die('Could not bring member back', e);
  console.log(`"${existing.display_name}" is back in the name list.`);
} else {
  const { error: e } = await db.from('members').insert({ display_name: name, active: true });
  if (e) die('Could not add member', e);
  console.log(`Added "${name}".`);
}
