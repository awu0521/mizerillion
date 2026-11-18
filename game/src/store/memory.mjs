// In-memory store for local development and tests. Milestone 2 adds a Supabase store with the
// same methods; the Worker only talks to whichever store it is given.
// Rows use the same column names as the planned Postgres tables.

export class MemoryStore {
  constructor({ bank, members = [] } = {}) {
    this.prompts = new Map((bank?.prompts || []).map(p => [p.id, {
      id: p.id, text: p.text, category: p.category, answers: structuredClone(p.answers),
      needs_review: !!p.review, enabled: !p.review, // prompts marked review stay off until someone enables them
      note: p.note ?? null, version: 0, updated_at: new Date(0).toISOString(),
      created_by_admin: false, text_edited: false, removed_answers: [],
    }]));
    this.audit = [];
    this.members = new Map(members.map(m => [m.id, { active: true, ...m }]));
    this.puzzles = new Map();
    this.runs = new Map();
    this.answers = [];
    this.guesses = [];
    this.attempts = { player: [], admin: [] };
    this.sessions = { player: new Map(), admin: new Map() };
  }
  // prompts
  async enabledPrompts() { return [...this.prompts.values()].filter(p => p.enabled).map(({ id, category }) => ({ id, category })); }
  async promptsByIds(ids) { return ids.map(id => this.prompts.get(id)).filter(Boolean).map(p => structuredClone(p)); }
  // members
  async member(id) { return this.members.get(id) || null; }
  async activeMembers() { return [...this.members.values()].filter(m => m.active).map(({ id, display_name }) => ({ id, display_name })).sort((a, b) => a.display_name.localeCompare(b.display_name)); }

  // login attempts and sessions; kind is 'player' (or 'admin', milestone 4)
  async loginAttempts(kind, ip, sinceIso) { return this.attempts[kind].filter(a => a.ip === ip && a.created_at >= sinceIso).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(({ created_at, success }) => ({ created_at, success })); }
  async recentFailures(kind, sinceIso) { return this.attempts[kind].filter(a => !a.success && a.created_at >= sinceIso).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(({ created_at }) => ({ created_at })); }
  async recordLoginAttempt(kind, { ip, success, created_at }) { this.attempts[kind].push({ ip, success, created_at }); }
  async attemptsSince(kind, sinceIso) { return this.attempts[kind].filter(a => a.created_at >= sinceIso).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(a => ({ ...a })); }
  /** Deletes failed attempts (for one IP, or all), which lifts the lockouts they caused. */
  async clearFailedAttempts(kind, ip = null) { this.attempts[kind] = this.attempts[kind].filter(a => a.success || (ip !== null && a.ip !== ip)); }
  async createSession(kind, row) { this.sessions[kind].set(row.token_hash, { member_id: null, revoked: false, ...row }); }
  /** The session plus, for players, the picked member's name and whether they're still active. */
  async getSession(kind, tokenHash) {
    const s = this.sessions[kind].get(tokenHash);
    if (!s) return null;
    const m = s.member_id ? this.members.get(s.member_id) : null;
    return { ...s, display_name: m?.display_name ?? null, member_active: m ? m.active : null };
  }
  async updateSession(kind, tokenHash, patch) { const s = this.sessions[kind].get(tokenHash); if (s) Object.assign(s, patch); }

  // admin editor
  async adminPrompts() { return [...this.prompts.values()].map(p => structuredClone(p)).sort((a, b) => a.id.localeCompare(b.id)); }
  async promptFull(id) { const p = this.prompts.get(id); return p ? structuredClone(p) : null; }
  /** Saves only if the prompt is still at `version`; returns the updated prompt, or null if it changed meanwhile. */
  async updatePrompt(id, version, patch, at) {
    const p = this.prompts.get(id);
    if (!p || p.version !== version) return null;
    Object.assign(p, structuredClone(patch), { version: version + 1, updated_at: at });
    return structuredClone(p);
  }
  /** Inserts a new prompt; returns false if the id is taken. */
  async createPrompt(row) {
    if (this.prompts.has(row.id)) return false;
    this.prompts.set(row.id, { answers: [], enabled: false, needs_review: false, note: null, version: 0, created_by_admin: false, text_edited: false, removed_answers: [], ...structuredClone(row) });
    return true;
  }
  async rejectedGuesses(promptId, limit = 30) {
    const groups = new Map();
    for (const g of this.guesses.filter(g => g.prompt_id === promptId && g.matched_answer === null && g.normalized)) {
      const x = groups.get(g.normalized) || { prompt_id: promptId, normalized: g.normalized, count: 0, example: g.raw, last_seen: g.created_at };
      x.count++; if (g.created_at >= x.last_seen) { x.last_seen = g.created_at; x.example = g.raw; }
      groups.set(g.normalized, x);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen)).slice(0, limit);
  }
  async addAudit(row) { this.audit.push({ id: this.audit.length + 1, ...structuredClone(row) }); }
  async recentAudit(limit = 100) { return this.audit.slice().sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id).slice(0, limit).map(r => structuredClone(r)); }
  // puzzles
  async getPuzzle(date) { return this.puzzles.get(date) || null; }
  /** Insert if absent; always returns the stored row (first writer wins). */
  async createPuzzle(row) { if (!this.puzzles.has(row.date)) this.puzzles.set(row.date, { ...row }); return this.puzzles.get(row.date); }
  async puzzlesBetween(fromDate, toDate) { return [...this.puzzles.values()].filter(p => p.date >= fromDate && p.date < toDate); }
  // runs
  async getRun(id) { const r = this.runs.get(id); return r ? { ...r } : null; }
  async getDailyRun(memberId, date) { const r = [...this.runs.values()].find(r => r.member_id === memberId && r.date === date && r.mode === 'daily'); return r ? { ...r } : null; }
  /** Creates a run; a second daily run for the same member and date returns the existing one. */
  async createRun(row) {
    if (row.mode === 'daily') { const existing = await this.getDailyRun(row.member_id, row.date); if (existing) return existing; }
    this.runs.set(row.id, { next_round: 0, paused_at: null, completed: false, ...row });
    return { ...this.runs.get(row.id) };
  }
  /** Starts the next round if it isn't already; returns the updated run, or null if nothing changed. */
  async startRound(id, roundStart) { const r = this.runs.get(id); if (!r || r.completed || r.round_start !== null) return null; r.round_start = roundStart; return { ...r }; }
  async pause(id, at) { const r = this.runs.get(id); if (r && r.paused_at === null) r.paused_at = at; }
  async resume(id, at) { const r = this.runs.get(id); if (r && r.paused_at !== null) { r.round_start += at - r.paused_at; r.paused_at = null; } }
  /** Atomically records a round's score and advances the run. Returns false if the round was already scored or not open. */
  async scoreRound(id, round, result, rounds) {
    const r = this.runs.get(id);
    if (!r || r.completed || r.round_start === null || r.next_round !== round) return false;
    if (this.answers.some(a => a.run_id === id && a.round === round)) return false;
    this.answers.push({ run_id: id, round, raw_answer: result.rawAnswer, answer: result.answer, tier: result.tier, score: result.score, created_at: result.createdAt });
    r.next_round = round + 1; r.round_start = null; r.completed = round + 1 >= rounds;
    return true;
  }
  async answersFor(id) { return this.answers.filter(a => a.run_id === id).sort((a, b) => a.round - b.round).map(a => ({ ...a })); }
  async logGuess(row) { this.guesses.push({ ...row }); }
  /** Completed daily runs for a date with each member's total and tiers. */
  async dailyBoard(date) {
    return [...this.runs.values()].filter(r => r.date === date && r.mode === 'daily' && r.completed).map(r => {
      const answers = this.answers.filter(a => a.run_id === r.id).sort((a, b) => a.round - b.round);
      return { run_id: r.id, member_id: r.member_id, display_name: this.members.get(r.member_id)?.display_name || 'Diver', score: answers.reduce((s, a) => s + a.score, 0), tiers: answers.map(a => a.tier) };
    });
  }
}
