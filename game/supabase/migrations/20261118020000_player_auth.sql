-- Player access: one shared password (hash in the Worker secret PLAYER_PASSWORD_HASH), login
-- attempts for lockouts, and sessions. Only the service role can touch these, like every other table.

create table public.player_login_attempts (
  id bigint generated always as identity primary key,
  ip text not null,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index player_login_attempts_by_ip on public.player_login_attempts (ip, created_at);
create index player_login_failures on public.player_login_attempts (created_at) where not success;

-- Only a SHA-256 hash of each session token is stored; the token itself lives in the player's cookie.
create table public.player_sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  member_id uuid references public.members(id) on delete set null, -- the name picked on this device
  password_fp text not null,       -- fingerprint of PLAYER_PASSWORD_HASH at login; a new hash logs everyone out
  ip text,
  user_agent text,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null
);
create index player_sessions_by_member on public.player_sessions (member_id);

-- A session with its picked member, in one read.
create view public.player_session_view with (security_invoker = true) as
select s.token_hash, s.member_id, s.password_fp, s.revoked, s.expires_at, s.last_seen,
       m.display_name, m.active as member_active
  from public.player_sessions s
  left join public.members m on m.id = s.member_id;

alter table public.player_login_attempts enable row level security;
alter table public.player_sessions enable row level security;
revoke all on public.player_login_attempts, public.player_sessions, public.player_session_view from anon, authenticated;
grant select, insert, update, delete on public.player_login_attempts, public.player_sessions to service_role;
grant select on public.player_session_view to service_role;
grant usage, select on all sequences in schema public to service_role;
