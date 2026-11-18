// Pure planning logic for seed_prompts.mjs (no I/O, so it can be tested with fake data).
//
// Rules:
// - New prompts are inserted; prompts with review: true start with enabled = false.
// - `enabled` is never written for existing prompts.
// - Answers are matched by normalize(answer). For an answer already in Supabase, its tier stays as it
//   is in Supabase (admin edits win) and its aliases are the union of the bank's and Supabase's.
// - If an existing prompt's content changed (text, category, note, answers added or removed, weight,
//   quip, auto_pick, or new aliases), that's a change: print a diff and require --force.
//   A different tier alone is not a change, because the Supabase tier is kept.
import { normalize, TIER_KEYS } from '../../public/rules.mjs';

const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const ANSWER_FIELDS = ['answer', 'aliases', 'tier', 'weight', 'quip', 'auto_pick'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sortedAliases = list => [...new Set((list || []).filter(a => typeof a === 'string' && a.trim()))].sort();

/** Returns { errors, warnings }. Errors stop the seed; warnings are printed. */
export function validateBank(bank) {
  const errors = [], warnings = [];
  if (!bank || !Array.isArray(bank.prompts)) return { errors: ['The file has no "prompts" array.'], warnings };
  const ids = new Set();
  for (const [i, p] of bank.prompts.entries()) {
    const where = `prompts[${i}]${p?.id ? ` (${p.id})` : ''}`;
    if (!ID.test(p?.id || '')) errors.push(`${where}: id must match ${ID}`);
    if (ids.has(p?.id)) errors.push(`${where}: duplicate id`);
    ids.add(p?.id);
    if (typeof p?.text !== 'string' || !p.text.trim()) errors.push(`${where}: missing text`);
    if (typeof p?.category !== 'string' || !p.category.trim()) errors.push(`${where}: missing category`);
    if (!Array.isArray(p?.answers) || !p.answers.length) { errors.push(`${where}: no answers`); continue; }
    const keys = new Set();
    for (const a of p.answers) {
      if (typeof a?.answer !== 'string' || !a.answer.trim()) errors.push(`${where}: an answer is empty`);
      else if (!normalize(a.answer)) {
        // normalize() keeps only a-z, 0-9 and emoji/symbols, so e.g. CJK text or "⁉" can't be typed to match.
        if (!(a.aliases || []).some(x => normalize(x))) warnings.push(`${where}: answer ${JSON.stringify(a.answer)} can't be matched by typing (normalizes to nothing); add an alias such as its romanization`);
      } else if (keys.has(normalize(a.answer))) errors.push(`${where}: duplicate answer ${JSON.stringify(a.answer)}`);
      else keys.add(normalize(a.answer));
      if (!TIER_KEYS.includes(a?.tier)) errors.push(`${where}: answer ${JSON.stringify(a?.answer)} has unknown tier ${JSON.stringify(a?.tier)}`);
      if (a?.aliases !== undefined && !Array.isArray(a.aliases)) errors.push(`${where}: aliases of ${JSON.stringify(a.answer)} must be a list`);
    }
  }
  return { errors, warnings };
}

const cleanAnswer = a => Object.fromEntries(ANSWER_FIELDS.filter(k => a[k] !== undefined).map(k => [k, k === 'aliases' ? sortedAliases(a[k]) : a[k]]));

/** Returns { merged, diff } for an existing prompt. diff is [] when nothing but tiers differ. */
export function mergePrompt(incoming, existing) {
  const diff = [];
  if (incoming.text !== existing.text) diff.push(`  text: ${JSON.stringify(existing.text)} -> ${JSON.stringify(incoming.text)}`);
  if (incoming.category !== existing.category) diff.push(`  category: ${existing.category} -> ${incoming.category}`);
  if ((incoming.note ?? null) !== (existing.note ?? null)) diff.push(`  note: ${JSON.stringify(existing.note ?? null)} -> ${JSON.stringify(incoming.note ?? null)}`);
  const dbByKey = new Map(existing.answers.map(a => [normalize(a.answer), a]));
  const inKeys = new Set();
  const merged = incoming.answers.map(raw => {
    const a = cleanAnswer(raw), key = normalize(a.answer), db = dbByKey.get(key);
    inKeys.add(key);
    if (!db) { diff.push(`  + ${JSON.stringify(a.answer)} (${a.tier})`); return a; }
    for (const field of ['weight', 'quip', 'auto_pick']) if (!same(a[field], db[field])) diff.push(`  ~ ${JSON.stringify(db.answer)} ${field}: ${JSON.stringify(db[field] ?? null)} -> ${JSON.stringify(a[field] ?? null)}`);
    if (a.answer !== db.answer) diff.push(`  ~ ${JSON.stringify(db.answer)} spelled ${JSON.stringify(a.answer)}`);
    const dbAliases = sortedAliases(db.aliases), newAliases = (a.aliases || []).filter(x => !dbAliases.includes(x));
    if (newAliases.length) diff.push(`  ~ ${JSON.stringify(db.answer)} new aliases: ${newAliases.map(x => JSON.stringify(x)).join(', ')}`);
    const aliases = sortedAliases([...dbAliases, ...(a.aliases || [])]);
    // Supabase tier wins; everything else comes from the bank.
    return { ...a, ...(aliases.length ? { aliases } : {}), tier: db.tier };
  });
  for (const [key, db] of dbByKey) if (!inKeys.has(key)) diff.push(`  - ${JSON.stringify(db.answer)} (${db.tier})`);
  return { merged, diff };
}

/**
 * @param bank      parsed prompt_bank.json
 * @param existing  rows from public.prompts: { id, text, category, note, answers, needs_review }
 * @returns { inserts, updates, unchanged, changed, onlyInDatabase }
 *   inserts: rows to insert (with enabled); updates: { id, row } without enabled;
 *   changed: [{ id, diff }] that need --force; updates only contains changed rows when force is true.
 */
export function planSeed(bank, existing, { force = false } = {}) {
  const byId = new Map(existing.map(r => [r.id, r]));
  const plan = { inserts: [], updates: [], unchanged: [], changed: [], onlyInDatabase: [] };
  for (const p of bank.prompts) {
    const base = { text: p.text, category: p.category, note: p.note ?? null, needs_review: !!p.review };
    const db = byId.get(p.id);
    if (!db) { plan.inserts.push({ id: p.id, ...base, answers: p.answers.map(cleanAnswer), enabled: !p.review }); continue; }
    const { merged, diff } = mergePrompt(p, db);
    const reviewChanged = !!db.needs_review !== !!p.review;
    if (diff.length) {
      plan.changed.push({ id: p.id, diff });
      if (force) plan.updates.push({ id: p.id, row: { ...base, answers: merged, updated_at: new Date().toISOString() } });
    } else if (reviewChanged) {
      plan.updates.push({ id: p.id, row: { needs_review: !!p.review, updated_at: new Date().toISOString() } });
    } else plan.unchanged.push(p.id);
  }
  const bankIds = new Set(bank.prompts.map(p => p.id));
  plan.onlyInDatabase = existing.filter(r => !bankIds.has(r.id)).map(r => r.id);
  return plan;
}
