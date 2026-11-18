-- Admin access (password hash in the Worker secret ADMIN_PASSWORD_HASH), the audit log, and what the
-- prompt editor needs. Only the service role can touch any of it.

create table public.admin_login_attempts (
  id bigint generated always as identity primary key,
  ip text not null,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index admin_login_attempts_by_ip on public.admin_login_attempts (ip, created_at);
create index admin_login_failures on public.admin_login_attempts (created_at) where not success;

-- Only a SHA-256 hash of each token is stored. `id` is what the audit log refers to.
create table public.admin_sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  id uuid not null unique default gen_random_uuid(),
  password_fp text not null,        -- fingerprint of ADMIN_PASSWORD_HASH; a new hash ends every session
  ip text,
  user_agent text,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),   -- sessions end after 30 minutes idle
  expires_at timestamptz not null                  -- and 8 hours after login
);

-- Every admin login attempt, logout and edit.
create table public.admin_audit (
  id bigint generated always as identity primary key,
  session_id uuid references public.admin_sessions(id) on delete set null,
  ip text,
  action text not null,
  prompt_id text,
  answer text,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);
create index admin_audit_recent on public.admin_audit (created_at desc);

-- Bumped on every change to a prompt, so two edits can't silently overwrite each other.
alter table public.prompts add column version integer not null default 0;

-- Wrong guesses per prompt, for adding missing aliases.
create view public.rejected_guesses with (security_invoker = true) as
select prompt_id, normalized,
       count(*)::integer as count,
       (array_agg(raw order by created_at desc))[1] as example,
       max(created_at) as last_seen
  from public.guess_log
 where matched_answer is null and normalized <> ''
 group by prompt_id, normalized;

alter table public.admin_login_attempts enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.admin_audit enable row level security;
revoke all on public.admin_login_attempts, public.admin_sessions, public.admin_audit, public.rejected_guesses from anon, authenticated;
grant select, insert, update, delete on public.admin_login_attempts, public.admin_sessions, public.admin_audit to service_role;
grant select on public.rejected_guesses to service_role;
grant usage, select on all sequences in schema public to service_role;
