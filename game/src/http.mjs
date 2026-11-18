// Small HTTP helpers shared by the game API (worker.mjs) and the admin API (admin.mjs).
export const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
export const fail = (message, status = 400, body = {}, headers = {}) => json({ error: message, ...body }, status, headers);
export const iso = t => new Date(t).toISOString();
export const addDays = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const clientIp = request => request.headers.get('CF-Connecting-IP') || 'local';
export function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
export const waitText = ms => { const m = Math.ceil(ms / 60000); return m >= 120 ? `${Math.ceil(m / 60)} hours` : m === 1 ? '1 minute' : `${m} minutes`; };
/** Reads a JSON body up to maxBytes. Returns { data } or { error: Response }. */
export async function readJson(request, maxBytes) {
  if (Number(request.headers.get('Content-Length') || 0) > maxBytes) return { error: fail('Request is too large.', 413) };
  const raw = await request.text();
  if (raw.length > maxBytes) return { error: fail('Request is too large.', 413) };
  try { return { data: JSON.parse(raw) }; } catch { return { data: undefined }; }
}
