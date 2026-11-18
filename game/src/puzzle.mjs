// Picks the 7 prompts for a dive.
// Rules: enabled prompts only; at most 2 per category; at most 1 whose id starts with
// "nicknames-" or "words-"; avoid prompts used in the last 14 days while enough others remain,
// and when some must be reused, reuse the ones seen longest ago first.
import { ROUNDS } from '../public/rules.mjs';

export const RECENT_DAYS = 14;
export const MAX_PER_CATEGORY = 2;
export const MAX_SPECIAL = 1;
export const isSpecial = id => /^(nicknames-|words-)/.test(id);

// Small deterministic PRNG (FNV-1a hash -> mulberry32) so a date always yields the same pick.
export function seededRandom(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const cryptoRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

function shuffle(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/**
 * @param prompts  [{id, category}] — enabled prompts only
 * @param options.random   () => [0,1)
 * @param options.lastUsed Map(id -> 'YYYY-MM-DD') of prompts used in the recent window
 * @param options.exclude  Set of ids to avoid if at all possible (e.g. today's daily, for practice)
 * @returns array of ROUNDS prompt ids
 */
export function pickPrompts(prompts, { random = cryptoRandom, lastUsed = new Map(), exclude = new Set(), count = ROUNDS } = {}) {
  if (prompts.length < count) throw new Error(`Need at least ${count} enabled prompts, found ${prompts.length}.`);
  const shuffled = shuffle(prompts, random);
  const fresh = shuffled.filter(p => !lastUsed.has(p.id) && !exclude.has(p.id));
  // Stable sort keeps the shuffled order among prompts last used on the same day.
  const stale = shuffled.filter(p => lastUsed.has(p.id) && !exclude.has(p.id)).sort((a, b) => lastUsed.get(a.id).localeCompare(lastUsed.get(b.id)));
  const excluded = shuffled.filter(p => exclude.has(p.id));
  const picked = [], perCategory = new Map();
  let special = 0;
  const take = (pool, capped) => {
    for (const p of pool) {
      if (picked.length >= count) return;
      if (picked.includes(p)) continue;
      if (capped && ((perCategory.get(p.category) || 0) >= MAX_PER_CATEGORY || (isSpecial(p.id) && special >= MAX_SPECIAL))) continue;
      picked.push(p); perCategory.set(p.category, (perCategory.get(p.category) || 0) + 1); if (isSpecial(p.id)) special++;
    }
  };
  take(fresh, true); take(stale, true); take(excluded, true);
  // Only if the bank is too small for the caps: fill the rest in the same preference order.
  take(fresh, false); take(stale, false); take(excluded, false);
  return shuffle(picked, random).map(p => p.id);
}

/**
 * The prompt ids `date`'s puzzle would get, from the puzzles stored for the 14 days before it.
 * `extraUsed` adds days that aren't stored yet (used by the admin preview of tomorrow).
 */
export async function choosePuzzleIds(store, date, extraUsed = []) {
  const from = new Date(Date.parse(date + 'T12:00:00Z') - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const recent = [...await store.puzzlesBetween(from, date), ...extraUsed].sort((a, b) => a.date.localeCompare(b.date));
  const lastUsed = new Map();
  for (const p of recent) for (const id of p.prompt_ids) lastUsed.set(id, p.date);
  return pickPrompts(await store.enabledPrompts(), { random: seededRandom(date), lastUsed });
}
