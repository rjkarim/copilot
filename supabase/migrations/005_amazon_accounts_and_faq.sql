-- Reusable Amazon Creators API accounts + optional FAQ per article.
-- Run this once in Supabase Dashboard > SQL Editor (after 001-004).

-- Saved Creators API credentials. Add one once, then pick it for any website.
-- The ID and Secret can be written from the browser but never read back.
create table if not exists public.amazon_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  credential_id text not null,
  credential_secret text not null,
  version text not null default '3.1',
  created_at timestamptz not null default now()
);
alter table public.amazon_accounts enable row level security;
drop policy if exists "own amazon accounts" on public.amazon_accounts;
create policy "own amazon accounts" on public.amazon_accounts for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.amazon_accounts from anon, authenticated;
grant select (id, user_id, name, version, created_at) on public.amazon_accounts to authenticated;
grant insert (id, name, credential_id, credential_secret, version) on public.amazon_accounts to authenticated;
grant update (name, credential_id, credential_secret, version) on public.amazon_accounts to authenticated;
grant delete on public.amazon_accounts to authenticated;

-- Each website points at one saved account (its tracking ID stays on the website).
alter table public.websites
  add column if not exists amazon_account_id uuid references public.amazon_accounts on delete set null;
grant select (amazon_account_id) on public.websites to authenticated;
grant insert (amazon_account_id) on public.websites to authenticated;
grant update (amazon_account_id) on public.websites to authenticated;

-- Credentials already saved on websites become reusable accounts, linked back.
insert into public.amazon_accounts (user_id, name, credential_id, credential_secret, version)
select distinct on (w.user_id, w.amazon_credential_id)
       w.user_id, 'Amazon API (' || w.name || ')', w.amazon_credential_id, w.amazon_credential_secret, w.amazon_version
  from public.websites w
 where coalesce(w.amazon_credential_id, '') <> '' and coalesce(w.amazon_credential_secret, '') <> ''
   and w.amazon_account_id is null
   and not exists (select 1 from public.amazon_accounts a
                    where a.user_id = w.user_id and a.credential_id = w.amazon_credential_id);
update public.websites w
   set amazon_account_id = a.id
  from public.amazon_accounts a
 where w.amazon_account_id is null and a.user_id = w.user_id and a.credential_id = w.amazon_credential_id;

-- FAQ section on or off, chosen when adding keywords.
alter table public.articles
  add column if not exists include_faq boolean not null default true;

create or replace view public.website_overview with (security_invoker = true) as
select
  w.id, w.user_id, w.name, w.url, w.wp_username, w.tracking_id, w.marketplace, w.language,
  w.post_status, w.sleep_seconds, w.paused, w.wp_published, w.wp_drafts, w.wp_synced_at,
  w.wp_error, w.next_run_at, w.created_at, w.has_wp_password,
  coalesce(s.queued, 0)::int as queued,
  coalesce(s.writing, 0)::int as writing,
  coalesce(s.completed, 0)::int as completed,
  coalesce(s.failed, 0)::int as failed,
  cur.keyword as current_keyword,
  cur.step as current_step,
  cur.progress as current_progress,
  w.amazon_version,
  (w.amazon_account_id is not null or w.has_amazon_keys) as has_amazon_keys,
  w.amazon_account_id
from public.websites w
left join lateral (
  select
    count(*) filter (where a.status = 'queued') as queued,
    count(*) filter (where a.status = 'writing') as writing,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'failed') as failed
  from public.articles a where a.website_id = w.id
) s on true
left join lateral (
  select a.keyword, a.step, a.progress
  from public.articles a where a.website_id = w.id and a.status = 'writing'
  order by a.started_at desc limit 1
) cur on true;
grant select on public.website_overview to authenticated;

-- Make the API notice the changes right away.
notify pgrst, 'reload schema';
