-- Game settings the admin page can change. For now: launch_date ("YYYY-MM-DD", Dive #1).
-- Before the launch date, players get preview dives and nothing is stored.
create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
revoke all on public.settings from anon, authenticated;
grant select, insert, update, delete on public.settings to service_role;
