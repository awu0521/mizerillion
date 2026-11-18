// Password hashing, tokens and comparisons. WebCrypto only, so it runs in the Worker and in Node.
// Stored hash format: pbkdf2$<iterations>$<salt base64>$<hash base64>  (PBKDF2-SHA256, 16-byte salt)
// Used for both PLAYER_PASSWORD_HASH and (milestone 4) ADMIN_PASSWORD_HASH.

export const PBKDF2_ITERATIONS = 100000; // the most Cloudflare Workers allows
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;
const enc = new TextEncoder();

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = bytes => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (typeof password !== 'string' || Array.from(password).length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}

export function parseHash(stored) {
  const m = /^pbkdf2\$(\d{1,7})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/.exec(typeof stored === 'string' ? stored.trim() : '');
  if (!m) return null;
  const iterations = Number(m[1]);
  if (iterations < 1 || iterations > PBKDF2_ITERATIONS) return null;
  try {
    const salt = unb64(m[2]), hash = unb64(m[3]);
    return salt.length >= 16 && hash.length === 32 ? { iterations, salt, hash } : null;
  } catch { return null; }
}

/** Constant-time comparison of two byte arrays (or two strings). */
export function timingSafeEqual(a, b) {
  if (typeof a === 'string') a = enc.encode(a);
  if (typeof b === 'string') b = enc.encode(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// Used when the stored hash is missing or malformed, so the work done is the same either way.
const DUMMY = { iterations: PBKDF2_ITERATIONS, salt: new Uint8Array(16), hash: new Uint8Array(32) };

/**
 * True only for the right password. Always runs one full PBKDF2 derivation, whether the password
 * is wrong, empty, too long, not a string, or the stored hash is broken, so timing reveals nothing.
 */
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored), target = parsed || DUMMY;
  const usable = typeof password === 'string' && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;
  const derived = await pbkdf2(usable ? password : '', target.salt, target.iterations);
  return timingSafeEqual(derived, target.hash) && usable && !!parsed;
}

export async function sha256hex(text) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))); }
/** A random 32-byte session token, base64url (43 characters). */
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
/** Short fingerprint of a stored password hash; sessions remember it so changing the hash logs everyone out. */
export async function fingerprint(stored) { return (await sha256hex('fp|' + String(stored ?? '').trim())).slice(0, 16); }
/** Per-session CSRF token, derived from the secret session token, so it never needs storing. */
export async function csrfFor(token, purpose) { return (await sha256hex(`csrf|${purpose}|${token}`)).slice(0, 43); }
