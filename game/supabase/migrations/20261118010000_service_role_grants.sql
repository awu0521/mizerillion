-- Give the Worker's role (service_role, used by the secret / service_role key) explicit access.
-- Newer Supabase projects can be set to not grant new tables to the API roles automatically; without
-- these grants the Worker gets "permission denied". anon and authenticated still get nothing.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.members, public.prompts, public.puzzles, public.runs, public.answers, public.guess_log to service_role;
grant select on public.daily_leaderboard, public.member_stats, public.member_streaks to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.score_round(uuid, integer, text, text, text, integer, integer) to service_role;
