-- Lets the admin page add prompts and answers and edit text, without seed_prompts.mjs undoing it.
-- Per-answer marks live inside prompts.answers (added_by_admin, renamed_from, quip_edited).
alter table public.prompts add column created_by_admin boolean not null default false; -- made on the admin page
alter table public.prompts add column text_edited boolean not null default false;      -- question or category edited there
alter table public.prompts add column removed_answers text[] not null default '{}';    -- normalized answers deleted there; never re-added by a seed
