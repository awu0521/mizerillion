// Reads settings for local scripts: the process environment first, then game/.dev.vars.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GAME_DIR = fileURLToPath(new URL('../../', import.meta.url));

export function parseDevVars(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}
/** Returns a message if the key is clearly not a server key (never includes the key itself). */
export function serviceKeyProblem(key) {
  const fix = 'Use the secret key (sb_secret_…) or the legacy service_role key from Project Settings → API Keys.';
  if (key.startsWith('sb_publishable_')) return `SUPABASE_SERVICE_ROLE_KEY is the publishable key, which the database refuses on purpose. ${fix}`;
  if (key.startsWith('sb_secret_')) return null;
  try {
    const role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role;
    if (role && role !== 'service_role') return `SUPABASE_SERVICE_ROLE_KEY is the "${role}" key, which the database refuses on purpose. ${fix}`;
  } catch { /* not a JWT; let Supabase decide */ }
  return null;
}
export function loadEnv(names) {
  const file = GAME_DIR + '.dev.vars';
  const vars = existsSync(file) ? parseDevVars(readFileSync(file, 'utf8')) : {};
  const env = Object.fromEntries(names.map(n => [n, process.env[n] || vars[n] || '']));
  const missing = names.filter(n => !env[n]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}. Set them in game/.dev.vars (see .dev.vars.example) or the environment.`);
  return env;
}
