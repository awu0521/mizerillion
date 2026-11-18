// Test double for the Supabase client: the subset of the query builder that SupabaseStore and the
// scripts use, translated to parameterised SQL against PGlite (real Postgres in WebAssembly).
// This lets the real migrations, constraints, views and score_round() run in the tests.
// Test-only code; production uses @supabase/supabase-js.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = name => { if (!IDENT.test(name)) throw new Error('bad identifier ' + name); return `"${name}"`; };

export async function createTestDatabase() {
  const pg = new PGlite({
    // Return values the way PostgREST does: dates and timestamps as strings, bigint as numbers.
    parsers: { 1082: v => v, 1114: v => v, 1184: v => new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString(), 20: v => Number(v) },
  });
  // Roles that exist on every Supabase project. Deliberately NO default privileges: like a Supabase
  // project with automatic table exposure turned off, so the migrations must grant what they need.
  await pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
                 grant usage on schema public to anon, authenticated;`);
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await pg.exec(readFileSync(new URL(f, dir), 'utf8'));
  return pg;
}

// Runs one statement as service_role, like the Supabase secret / service_role key does.
const asServiceRole = (pg, sql, params) => pg.transaction(async tx => { await tx.exec('set local role service_role'); return tx.query(sql, params); });

class Query {
  constructor(pg, table) { this.pg = pg; this.table = table; this.filters = []; this.params = []; this.op = 'select'; this.cols = '*'; this.orderBy = null; this.mode = 'many'; this.returning = null; }
  p(v) { this.params.push(v); return '$' + this.params.length; }
  select(cols = '*') { if (this.op === 'select') this.cols = cols; else this.returning = cols; return this; }
  insert(rows) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows, { onConflict, ignoreDuplicates } = {}) { this.insert(rows); this.conflict = { onConflict, ignoreDuplicates }; return this; }
  update(values) { this.op = 'update'; this.values = values; return this; }
  eq(c, v) { this.filters.push(() => `${ident(c)} = ${this.p(v)}`); return this; }
  gte(c, v) { this.filters.push(() => `${ident(c)} >= ${this.p(v)}`); return this; }
  lt(c, v) { this.filters.push(() => `${ident(c)} < ${this.p(v)}`); return this; }
  is(c, v) { if (v !== null) throw new Error('is() only supports null'); this.filters.push(() => `${ident(c)} is null`); return this; }
  in(c, list) { this.filters.push(() => `${ident(c)} = any(${this.p(list)})`); return this; }
  order(c, { ascending = true } = {}) { this.orderBy = `${ident(c)} ${ascending ? 'asc' : 'desc'}`; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  colList(cols) { return cols === '*' ? '*' : cols.split(',').map(c => ident(c.trim())).join(','); }
  build() {
    const t = ident(this.table), where = () => this.filters.length ? ' where ' + this.filters.map(f => f()).join(' and ') : '';
    if (this.op === 'select') return `select ${this.colList(this.cols)} from ${t}${where()}${this.orderBy ? ' order by ' + this.orderBy : ''}`;
    if (this.op === 'update') {
      const sets = Object.entries(this.values).map(([k, v]) => `${ident(k)} = ${this.p(v)}`).join(', ');
      return `update ${t} set ${sets}${where()}${this.returning ? ' returning ' + this.colList(this.returning) : ''}`;
    }
    const keys = [...new Set(this.rows.flatMap(Object.keys))];
    const values = this.rows.map(r => '(' + keys.map(k => r[k] === undefined ? 'default' : this.p(r[k])).join(',') + ')').join(',');
    const conflict = this.conflict ? ` on conflict (${ident(this.conflict.onConflict)}) ` + (this.conflict.ignoreDuplicates ? 'do nothing' : 'do update set ' + keys.map(k => `${ident(k)} = excluded.${ident(k)}`).join(', ')) : '';
    return `insert into ${t} (${keys.map(ident).join(',')}) values ${values}${conflict}${this.returning ? ' returning ' + this.colList(this.returning) : ''}`;
  }
  async run() {
    try {
      const { rows } = await asServiceRole(this.pg, this.build(), this.params.map(v => v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : Array.isArray(v) && v.some(x => x && typeof x === 'object') ? JSON.stringify(v) : v));
      if (this.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: `expected 1 row, got ${rows.length}`, code: 'PGRST116' } };
      if (this.mode === 'maybe') return rows.length > 1 ? { data: null, error: { message: 'more than one row', code: 'PGRST116' } } : { data: rows[0] ?? null, error: null };
      return { data: this.op === 'select' || this.returning ? rows : null, error: null };
    } catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
  }
  then(resolve, reject) { return this.run().then(resolve, reject); }
}

export function fakeSupabase(pg) {
  return {
    from: table => new Query(pg, table),
    async rpc(name, args) {
      try {
        const keys = Object.keys(args);
        const { rows } = await asServiceRole(pg, `select ${ident(name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')}) as result`, keys.map(k => args[k]));
        return { data: rows[0].result, error: null };
      } catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
    },
  };
}
