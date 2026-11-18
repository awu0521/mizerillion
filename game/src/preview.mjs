// Preview dives (before the launch date): nothing is stored. The dive's state travels with the
// browser as a signed token (HMAC-SHA256), so the server can trust it without writing it down.
// The token holds prompt ids, round, clock and this dive's results, never any answer list.
// It's tied to the player session that started it, and changing the player password or Supabase
// key invalidates every preview token.
const enc = new TextEncoder(), dec = new TextDecoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export const PREVIEW_TOKEN = /^[A-Za-z0-9_-]{20,3000}\.[A-Za-z0-9_-]{43}$/;

const keys = new Map();
async function hmacKey(env) {
  const secret = `mizerillion-preview|${env.PLAYER_PASSWORD_HASH || ''}|${env.SUPABASE_SERVICE_ROLE_KEY || ''}`;
  if (!keys.has(secret)) keys.set(secret, crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  return keys.get(secret);
}

/** run: { sid, date, prompt_ids, next_round, round_start, paused_at, completed, results } */
export async function signRun(run, env) {
  const body = b64url(enc.encode(JSON.stringify({ v: 1, ...run })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** The run in a token, or null if it's malformed, forged, altered, or from another session. */
export async function readRun(token, env, sid) {
  if (typeof token !== 'string' || !PREVIEW_TOKEN.test(token)) return null;
  const [body, sig] = token.split('.');
  try {
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env), unb64url(sig), enc.encode(body))) return null;
    const run = JSON.parse(dec.decode(unb64url(body)));
    return run.v === 1 && run.sid === sid ? run : null;
  } catch { return null; }
}
