// Supabase (Postgres) store. Same methods as MemoryStore. Uses the service-role key, which only the
// Worker holds; the browser never talks to Supabase. Queries go through the Supabase client only.
import { createClient } from '@supabase/supabase-js';

const RUN_COLUMNS = 'id,member_id,date,mode,prompt_ids,next_round,round_start,paused_at,completed,created_at';
const UNIQUE_VIOLATION = '23505';
const PROMPT_COLUMNS = 'id,text,category,answers,enabled,needs_review,note,version,updated_at,created_by_admin,text_edited,removed_answers';

// PostgREST returns bigint columns as numbers; keep that explicit for the clock fields.
const toRun = r => r && { ...r, round_start: r.round_start === null ? null : Number(r.round_start), paused_at: r.paused_at === null ? null : Number(r.paused_at) };
function check({ data, error }, what) {
  if (error) throw new Error(`Supabase ${what} failed: ${error.message}`);
  return data;
}

export function supabaseClient(url, key, fetchImpl) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

export class SupabaseStore {
  constructor(client) { this.db = client; }

  // prompts
  async enabledPrompts() {
    return check(await this.db.from('prompts').select('id,category').eq('enabled', true), 'enabledPrompts');
  }
  async promptsByIds(ids) {
    if (!ids.length) return [];
    const rows = check(await this.db.from('prompts').select('id,text,category,answers').in('id', ids), 'promptsByIds');
    const byId = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => byId.get(id)).filter(Boolean);
  }

  // members
  async member(id) {
    return check(await this.db.from('members').select('id,display_name,active,created_at').eq('id', id).maybeSingle(), 'member');
  }
  async activeMembers() {
    return check(await this.db.from('members').select('id,display_name').eq('active', true).order('display_name'), 'activeMembers');
  }

  // login attempts and sessions; kind is 'player' (or 'admin', milestone 4)
  table(kind, what) { if (!['player', 'admin'].includes(kind)) throw new Error('bad session kind'); return `${kind}_${what}`; }
  async loginAttempts(kind, ip, sinceIso) {
    return check(await this.db.from(this.table(kind, 'login_attempts')).select('created_at,success').eq('ip', ip).gte('created_at', sinceIso).order('created_at'), 'loginAttempts');
  }
  async recentFailures(kind, sinceIso) {
    return check(await this.db.from(this.table(kind, 'login_attempts')).select('created_at').eq('success', false).gte('created_at', sinceIso).order('created_at'), 'recentFailures');
  }
  async recordLoginAttempt(kind, { ip, success, created_at }) {
    check(await this.db.from(this.table(kind, 'login_attempts')).insert({ ip, success, created_at }), 'recordLoginAttempt');
  }
  async createSession(kind, row) { check(await this.db.from(this.table(kind, 'sessions')).insert(row), 'createSession'); }
  /** The session plus, for players, the picked member's name and whether they're still active. */
  async getSession(kind, tokenHash) {
    const source = kind === 'player' ? 'player_session_view' : this.table(kind, 'sessions');
    return check(await this.db.from(source).select('*').eq('token_hash', tokenHash).maybeSingle(), 'getSession');
  }
  async updateSession(kind, tokenHash, patch) { check(await this.db.from(this.table(kind, 'sessions')).update(patch).eq('token_hash', tokenHash), 'updateSession'); }

  // admin editor
  async adminPrompts() {
    return check(await this.db.from('prompts').select(PROMPT_COLUMNS).order('id'), 'adminPrompts');
  }
  async promptFull(id) {
    return check(await this.db.from('prompts').select(PROMPT_COLUMNS).eq('id', id).maybeSingle(), 'promptFull');
  }
  /** Saves only if the prompt is still at `version`; returns the updated prompt, or null if it changed meanwhile. */
  async updatePrompt(id, version, patch, at) {
    const rows = check(await this.db.from('prompts').update({ ...patch, version: version + 1, updated_at: at }).eq('id', id).eq('version', version).select(PROMPT_COLUMNS), 'updatePrompt');
    return rows?.[0] || null;
  }
  /** Inserts a new prompt; returns false if the id is taken. */
  async createPrompt(row) {
    const { error } = await this.db.from('prompts').insert(row);
    if (error?.code === UNIQUE_VIOLATION) return false;
    check({ error }, 'createPrompt');
    return true;
  }
  async rejectedGuesses(promptId, limit = 30) {
    return check(await this.db.from('rejected_guesses').select('prompt_id,normalized,count,example,last_seen').eq('prompt_id', promptId).order('count', { ascending: false }).limit(limit), 'rejectedGuesses');
  }
  async addAudit(row) { check(await this.db.from('admin_audit').insert(row), 'addAudit'); }
  async recentAudit(limit = 100) {
    return check(await this.db.from('admin_audit').select('id,session_id,ip,action,prompt_id,answer,old_value,new_value,created_at').order('created_at', { ascending: false }).limit(limit), 'recentAudit');
  }

  // puzzles
  async getPuzzle(date) {
    return check(await this.db.from('puzzles').select('date,day_number,prompt_ids').eq('date', date).maybeSingle(), 'getPuzzle');
  }
  /** Insert if absent; always returns the stored row, so the first writer wins a race. */
  async createPuzzle(row) {
    check(await this.db.from('puzzles').upsert(row, { onConflict: 'date', ignoreDuplicates: true }), 'createPuzzle');
    return this.getPuzzle(row.date);
  }
  async puzzlesBetween(fromDate, toDate) {
    return check(await this.db.from('puzzles').select('date,day_number,prompt_ids').gte('date', fromDate).lt('date', toDate), 'puzzlesBetween');
  }

  // runs
  async getRun(id) {
    return toRun(check(await this.db.from('runs').select(RUN_COLUMNS).eq('id', id).maybeSingle(), 'getRun'));
  }
  async getDailyRun(memberId, date) {
    return toRun(check(await this.db.from('runs').select(RUN_COLUMNS).eq('member_id', memberId).eq('date', date).eq('mode', 'daily').maybeSingle(), 'getDailyRun'));
  }
  /** A second daily run for the same member and date returns the existing one (unique index). */
  async createRun(row) {
    const { id, member_id, date, mode, prompt_ids, round_start } = row;
    const { data, error } = await this.db.from('runs').insert({ id, member_id, date, mode, prompt_ids, round_start }).select(RUN_COLUMNS).single();
    if (error?.code === UNIQUE_VIOLATION && mode === 'daily') return this.getDailyRun(member_id, date);
    return toRun(check({ data, error }, 'createRun'));
  }
  /** Starts the next round if it isn't already; returns the updated run, or null if nothing changed. */
  async startRound(id, roundStart) {
    const rows = check(await this.db.from('runs').update({ round_start: roundStart }).eq('id', id).is('round_start', null).eq('completed', false).select(RUN_COLUMNS), 'startRound');
    return toRun(rows?.[0] || null);
  }
  async pause(id, at) {
    check(await this.db.from('runs').update({ paused_at: at }).eq('id', id).is('paused_at', null), 'pause');
  }
  async resume(id, at) {
    const run = await this.getRun(id);
    if (!run || run.paused_at === null) return;
    // Conditional on the paused_at we read, so two resumes can't both shift the clock.
    check(await this.db.from('runs').update({ round_start: run.round_start + (at - run.paused_at), paused_at: null }).eq('id', id).eq('paused_at', run.paused_at), 'resume');
  }
  /** Atomic: see public.score_round in the migration. */
  async scoreRound(id, round, result, rounds) {
    return check(await this.db.rpc('score_round', { p_run_id: id, p_round: round, p_raw_answer: result.rawAnswer, p_answer: result.answer, p_tier: result.tier, p_score: result.score, p_rounds: rounds }), 'scoreRound') === true;
  }
  async answersFor(id) {
    return check(await this.db.from('answers').select('run_id,round,raw_answer,answer,tier,score,created_at').eq('run_id', id).order('round'), 'answersFor');
  }
  async logGuess({ run_id, prompt_id, round, raw, normalized, matched_answer }) {
    check(await this.db.from('guess_log').insert({ run_id, prompt_id, round, raw, normalized, matched_answer }), 'logGuess');
  }
  /** Completed daily runs for a date with each member's total and tiers. */
  async dailyBoard(date) {
    return check(await this.db.from('daily_leaderboard').select('run_id,member_id,display_name,score,tiers,rank').eq('date', date), 'dailyBoard');
  }
}
