-- Mizerillion game schema.
-- The Cloudflare Worker is the only client and uses the service-role key. Row level security is on
-- for every table with no anon/authenticated policies, and those roles also lose all privileges,
-- so the public anon key (which the browser never gets anyway) can read or write nothing.

-- Members of the group chat. Players pick their name from this list after the shared password.
create table public.members (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index members_display_name_key on public.members (lower(display_name));

-- The prompt bank, seeded from bank_generation/data/prompt_bank.json by scripts/seed_prompts.mjs.
-- answers: [{ answer, aliases?, tier, weight?, quip?, auto_pick? }]
create table public.prompts (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  text text not null,
  category text not null,
  answers jsonb not null check (jsonb_typeof(answers) = 'array'),
  enabled boolean not null default true,   -- seeding sets this to false for review prompts, then never touches it
  needs_review boolean not null default false,
  note text,
  updated_at timestamptz not null default now()
);

-- One row per game day (America/Vancouver). Chosen the first time someone opens the day, then fixed.
create table public.puzzles (
  date date primary key,
  day_number integer not null,
  prompt_ids text[] not null check (cardinality(prompt_ids) = 7),
  created_at timestamptz not null default now()
);

-- A dive. Times are epoch milliseconds set by the Worker (the server owns the clock).
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  date date not null,
  mode text not null check (mode in ('daily', 'practice')),
  prompt_ids text[] not null check (cardinality(prompt_ids) = 7),
  next_round integer not null default 0 check (next_round between 0 and 7),
  round_start bigint,          -- when the current round's 25 s starts; null between rounds
  paused_at bigint,
  completed boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index runs_one_daily_per_member on public.runs (member_id, date) where mode = 'daily';
create index runs_daily_results on public.runs (date, mode, completed);

-- One scored round. Scores are fixed once written; later tier edits don't change them.
create table public.answers (
  run_id uuid not null references public.runs(id) on delete cascade,
  round integer not null check (round between 0 and 6),
  raw_answer text,
  answer text,
  tier text check (tier in ('plankton', 'tooclever', 'schooler', 'rare', 'deepcut', 'krillion')),
  score integer not null check (score in (0, 10, 15, 30, 60, 85, 100)),
  created_at timestamptz not null default now(),
  primary key (run_id, round)
);

-- Every guess, including rejected ones, for adding aliases and re-tiering later.
create table public.guess_log (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.runs(id) on delete cascade,
  prompt_id text not null,
  round integer not null check (round between 0 and 6),
  raw text not null,
  normalized text not null,
  matched_answer text,
  created_at timestamptz not null default now()
);
create index guess_log_by_prompt on public.guess_log (prompt_id, matched_answer);
create index guess_log_by_run on public.guess_log (run_id);

-- Scores a round and advances the run in one transaction. Returns false if the round was already
-- scored, isn't open, or the run is paused, so retries and races can't score twice.
create function public.score_round(
  p_run_id uuid, p_round integer, p_raw_answer text, p_answer text, p_tier text, p_score integer, p_rounds integer default 7
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  v_updated integer;
begin
  update public.runs
     set next_round = p_round + 1, round_start = null, completed = (p_round + 1 >= p_rounds)
   where id = p_run_id and next_round = p_round and round_start is not null and paused_at is null and not completed;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;
  end if;
  insert into public.answers (run_id, round, raw_answer, answer, tier, score)
  values (p_run_id, p_round, p_raw_answer, p_answer, p_tier, p_score);
  return true;
end;
$$;

-- Completed daily dives with totals, tiers in round order, and rank for the day.
create view public.daily_leaderboard with (security_invoker = true) as
select r.date, r.id as run_id, r.member_id, m.display_name,
       coalesce(sum(a.score), 0)::integer as score,
       array_agg(a.tier order by a.round) as tiers,
       rank() over (partition by r.date order by coalesce(sum(a.score), 0) desc)::integer as rank
  from public.runs r
  join public.members m on m.id = r.member_id
  left join public.answers a on a.run_id = r.id
 where r.mode = 'daily' and r.completed
 group by r.date, r.id, r.member_id, m.display_name;

-- All-time daily stats per member (practice never counts).
create view public.member_stats with (security_invoker = true) as
select m.id as member_id, m.display_name, m.active,
       count(d.run_id)::integer as dives,
       coalesce(round(avg(d.score)), 0)::integer as average,
       coalesce(max(d.score), 0)::integer as best,
       coalesce(sum(d.score), 0)::integer as total
  from public.members m
  left join public.daily_leaderboard d on d.member_id = m.id
 group by m.id, m.display_name, m.active;

-- Daily streaks per member. A streak is current if its last day is today or yesterday in Vancouver.
create view public.member_streaks with (security_invoker = true) as
with days as (
  select member_id, date, date - (row_number() over (partition by member_id order by date))::integer as grp
    from public.daily_leaderboard
), islands as (
  select member_id, max(date) as end_date, count(*)::integer as length
    from days group by member_id, grp
)
select member_id,
       max(length)::integer as best_streak,
       coalesce(max(length) filter (where end_date >= (now() at time zone 'America/Vancouver')::date - 1), 0)::integer as current_streak,
       max(end_date) as last_played
  from islands
 group by member_id;

-- Lock everything down to the service role.
alter table public.members enable row level security;
alter table public.prompts enable row level security;
alter table public.puzzles enable row level security;
alter table public.runs enable row level security;
alter table public.answers enable row level security;
alter table public.guess_log enable row level security;

revoke all on public.members, public.prompts, public.puzzles, public.runs, public.answers, public.guess_log,
              public.daily_leaderboard, public.member_stats, public.member_streaks
  from anon, authenticated;
revoke all on function public.score_round(uuid, integer, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.score_round(uuid, integer, text, text, text, integer, integer) to service_role;
