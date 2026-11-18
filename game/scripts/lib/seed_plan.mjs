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
  // Question text / category edited on the admin page win over the bank.
  if (!existing.text_edited) {
    if (incoming.text !== existing.text) diff.push(`  text: ${JSON.stringify(existing.text)} -> ${JSON.stringify(incoming.text)}`);
    if (incoming.category !== existing.category) diff.push(`  category: ${existing.category} -> ${incoming.category}`);
  }
  if ((incoming.note ?? null) !== (existing.note ?? null)) diff.push(`  note: ${JSON.stringify(existing.note ?? null)} -> ${JSON.stringify(incoming.note ?? null)}`);
  const removed = new Set(existing.removed_answers || []); // deleted on the admin page: never re-added
  // A Supabase answer is found by its text, or by the bank text it had before an admin renamed it.
  const dbByKey = new Map();
  for (const a of existing.answers) { dbByKey.set(normalize(a.answer), a); if (a.renamed_from) dbByKey.set(normalize(a.renamed_from), a); }
  const matched = new Set();
  const merged = [];
  for (const raw of incoming.answers) {
    const a = cleanAnswer(raw), key = normalize(a.answer);
    if (removed.has(key)) continue;
    const db = dbByKey.get(key);
    if (!db) { diff.push(`  + ${JSON.stringify(a.answer)} (${a.tier})`); merged.push(a); continue; }
    matched.add(db);
    const fieldsToCheck = db.quip_edited ? ['weight', 'auto_pick'] : ['weight', 'quip', 'auto_pick'];
    for (const field of fieldsToCheck) if (!same(a[field], db[field])) diff.push(`  ~ ${JSON.stringify(db.answer)} ${field}: ${JSON.stringify(db[field] ?? null)} -> ${JSON.stringify(a[field] ?? null)}`);
    if (!db.renamed_from && a.answer !== db.answer) diff.push(`  ~ ${JSON.stringify(db.answer)} spelled ${JSON.stringify(a.answer)}`);
    const dbAliases = sortedAliases(db.aliases), newAliases = (a.aliases || []).filter(x => !dbAliases.includes(x) && normalize(x) !== normalize(db.answer));
    if (newAliases.length) diff.push(`  ~ ${JSON.stringify(db.answer)} new aliases: ${newAliases.map(x => JSON.stringify(x)).join(', ')}`);
    const aliases = sortedAliases([...dbAliases, ...newAliases]);
    // Supabase wins for the tier, and for the answer text and quip if they were edited there.
    const out = { ...a, ...(aliases.length ? { aliases } : {}), tier: db.tier };
    if (db.renamed_from) { out.answer = db.answer; out.renamed_from = db.renamed_from; }
    if (db.quip_edited) { delete out.quip; if (db.quip) out.quip = db.quip; out.quip_edited = true; }
    merged.push(out);
  }
  for (const db of existing.answers) {
    if (matched.has(db)) continue;
    if (db.added_by_admin) merged.push(db); // added on the admin page: kept
    else diff.push(`  - ${JSON.stringify(db.answer)} (${db.tier})`);
  }
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
  const plan = { inserts: [], updates: [], unchanged: [], changed: [], onlyInDatabase: [], conflicts: [] };
  for (const p of bank.prompts) {
    const db = byId.get(p.id);
    const base = { text: db?.text_edited ? db.text : p.text, category: db?.text_edited ? db.category : p.category, note: p.note ?? null, needs_review: !!p.review };
    if (!db) { plan.inserts.push({ id: p.id, ...base, answers: p.answers.map(cleanAnswer), enabled: !p.review }); continue; }
    // A prompt made on the admin page that happens to share an id with the bank is never overwritten.
    if (db.created_by_admin) { plan.conflicts.push(p.id); continue; }
    const { merged, diff } = mergePrompt(p, db);
    const reviewChanged = !!db.needs_review !== !!p.review;
    if (diff.length) {
      plan.changed.push({ id: p.id, diff });
      if (force) plan.updates.push({ id: p.id, row: { ...base, answers: merged, version: (db.version ?? 0) + 1, updated_at: new Date().toISOString() } });
    } else if (reviewChanged) {
      plan.updates.push({ id: p.id, row: { needs_review: !!p.review, updated_at: new Date().toISOString() } });
    } else plan.unchanged.push(p.id);
  }
  const bankIds = new Set(bank.prompts.map(p => p.id));
  plan.onlyInDatabase = existing.filter(r => !bankIds.has(r.id)).map(r => r.id);
  return plan;
}
