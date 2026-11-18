// In-memory store for local development and tests. Milestone 2 adds a Supabase store with the
// same methods; the Worker only talks to whichever store it is given.
// Rows use the same column names as the planned Postgres tables.

export class MemoryStore {
  constructor({ bank, members = [] } = {}) {
    this.prompts = new Map((bank?.prompts || []).map(p => [p.id, {
      id: p.id, text: p.text, category: p.category, answers: structuredClone(p.answers),
      needs_review: !!p.review, enabled: !p.review, // prompts marked review stay off until someone enables them
    }]));
    this.members = new Map(members.map(m => [m.id, { active: true, ...m }]));
    this.puzzles = new Map();
    this.runs = new Map();
    this.answers = [];
    this.guesses = [];
  }
  // prompts
  async enabledPrompts() { return [...this.prompts.values()].filter(p => p.enabled).map(({ id, category }) => ({ id, category })); }
  async promptsByIds(ids) { return ids.map(id => this.prompts.get(id)).filter(Boolean).map(p => structuredClone(p)); }
  // members
  async member(id) { return this.members.get(id) || null; }
  async ensureMember(id, displayName) {
    if (!this.members.has(id)) this.members.set(id, { id, display_name: displayName, active: true, created_at: new Date().toISOString() });
    return this.members.get(id);
  }
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
