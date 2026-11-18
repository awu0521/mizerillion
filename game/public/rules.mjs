// Game rules shared by the Worker and the browser. Ported from OpenKrillion's public/rules.mjs (MIT).
// Changes: emoji-preserving normalize(), code-point lengths, Vancouver day, Mizerillion share text.
// This file must never contain prompt or answer data.
import { GAME } from './site.mjs';

export const TIERS = {
  plankton: { name: 'Plankton', score: 10, emoji: '🫧', color: '#8fa3c4', blurb: 'The answer everyone blurts out.' },
  tooclever: { name: 'Too Clever', score: 15, emoji: '🤡', color: '#ff9f43', blurb: 'The obscure answer the whole school thought of.' },
  schooler: { name: 'Schooler', score: 30, emoji: '🐟', color: '#4de3ff', blurb: 'Solid — swims with the school.' },
  rare: { name: 'Rare', score: 60, emoji: '🦑', color: '#ff5252', blurb: 'An uncommon answer. Nice pull.' },
  deepcut: { name: 'Deep Cut', score: 85, emoji: '🏮', color: '#9d7bff', blurb: 'True obscurity. Few go this deep.' },
  krillion: { name: 'One in a Krillion', score: 100, emoji: '🌟', color: '#ffd166', blurb: 'The designated gem. Trench floor.' },
};
export const TIER_KEYS = Object.keys(TIERS);
export const BANDS = [
  { min: 0, max: 150, tier: 'plankton', name: 'Plankton', text: 'Plenty of ocean left down there.' },
  { min: 151, max: 250, tier: 'schooler', name: 'Schooler', text: 'Swimming with the school.' },
  { min: 251, max: 350, tier: 'rare', name: 'Rare', text: 'Below the thermocline. Nice.' },
  { min: 351, max: 449, tier: 'deepcut', name: 'Deep cut', text: 'Seriously deep dive.' },
  { min: 450, max: 700, tier: 'krillion', name: 'One in a krillion', text: 'Trench dweller. Absurd.' },
];
export const ROUND_MS = 25000;
export const PREVIEW_MS = 3000;
export const GRACE_MS = 1500; // network grace for the client's own timed submission only
export const ROUNDS = 7;
export const MAX_SCORE = 700;
export const METRES_PER_POINT = 10;
export const bandFor = score => [...BANDS].reverse().find(b => score >= b.min) || BANDS[0];

// Same rule as normalize() in bank_generation/tools/make_prompts.py:
// NFKD, drop combining marks, lowercase, & -> and, then keep a-z, 0-9 and
// symbols (general category So/Sk) above U+2000, so emoji answers survive.
const SYMBOL = /^[\p{So}\p{Sk}]$/u;
export function normalize(value) {
  const s = String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, 'and');
  let out = '';
  for (const ch of s) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || (ch.codePointAt(0) > 0x2000 && SYMBOL.test(ch))) out += ch;
  }
  return out;
}
// Levenshtein distance over code points (pass arrays or strings), with an early-exit limit.
export function distance(a, b, limit = Infinity) {
  a = Array.from(a); b = Array.from(b);
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...next) > limit) return limit + 1;
    row = next;
  }
  return row[b.length];
}
export function matchAnswer(input, answers) {
  const key = normalize(input), length = Array.from(key).length;
  if (!key || length > 256) return null;
  const entries = answers.flatMap(a => [a.answer, ...(a.aliases || [])].map(word => ({ a, key: normalize(word) }))).filter(e => e.key);
  const exact = entries.find(e => e.key === key);
  if (exact) return { ...exact.a, correction: key !== normalize(exact.a.answer) };
  // Stretched letters: "lmaoooo" / "bruhhh" / "Thomas ERRRGH Sing" match once repeats are collapsed, if only one answer fits.
  const squeeze = s => s.replace(/(.)\1+/gu, '$1'), sq = squeeze(key);
  if (Array.from(sq).length >= 3) {
    const hits = entries.filter(e => squeeze(e.key) === sq);
    if (hits.length && hits.every(e => e.a.answer === hits[0].a.answer)) return { ...hits[0].a, correction: true };
  }
  const allowance = length < 4 ? 0 : length < 8 ? 1 : 2;
  const candidates = entries.map(e => ({ ...e, d: distance(key, e.key, allowance) })).filter(e => e.d <= allowance).sort((x, y) => x.d - y.d);
  if (candidates.length && (!candidates[1] || candidates[0].d < candidates[1].d || candidates[0].a.answer === candidates[1].a.answer)) return { ...candidates[0].a, correction: true };
  return null;
}

// The game day is the calendar date in Vancouver; it rolls over at local midnight.
export function gameDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: GAME.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
// Epoch ms of the midnight that ends `date` (handles DST: 07:00Z in summer, 08:00Z in winter).
export function resetAt(date) {
  const next = new Date(date + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
  const day = next.toISOString().slice(0, 10), base = Date.parse(day + 'T00:00:00Z');
  for (let h = -14; h <= 14; h++) if (gameDate(base + h * 3600000) === day) return base + h * 3600000;
  return base;
}
export const dayNumber = date => Math.round((Date.parse(date) - Date.parse(GAME.launchDate)) / 86400000) + 1;
export function shareText(day, results, practice = false) {
  const score = results.reduce((s, r) => s + r.score, 0);
  return `${GAME.name}${practice ? ' practice' : ''} #${day} 🦐\n${score}/${MAX_SCORE} · ${score * METRES_PER_POINT}m\n${results.map(r => TIERS[r.tier]?.emoji || '⬛').join('')}`;
}
