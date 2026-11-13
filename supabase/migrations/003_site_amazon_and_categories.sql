-- Amazon Creators API credentials per website + WordPress category per article.
-- Run this once in Supabase Dashboard > SQL Editor (after 001 and 002).

-- Each website gets its own Creators API credentials (write-only from the browser).
alter table public.websites
  add column if not exists amazon_credential_id text,
  add column if not exists amazon_credential_secret text,
  add column if not exists amazon_version text not null default '3.1',
  add column if not exists has_amazon_keys boolean generated always as
    (coalesce(amazon_credential_id, '') <> '' and coalesce(amazon_credential_secret, '') <> '') stored;

grant select (amazon_version, has_amazon_keys) on public.websites to authenticated;
grant insert (amazon_credential_id, amazon_credential_secret, amazon_version) on public.websites to authenticated;
grant update (amazon_credential_id, amazon_credential_secret, amazon_version) on public.websites to authenticated;

-- Websites that already exist start with the credentials saved earlier in Settings.
update public.websites w
   set amazon_credential_id = s.amazon_credential_id,
       amazon_credential_secret = s.amazon_credential_secret,
       amazon_version = s.amazon_version
  from public.settings s
 where s.user_id = w.user_id
   and w.amazon_credential_id is null
   and coalesce(s.amazon_credential_id, '') <> '';

-- The WordPress category chosen when the keyword was added.
alter table public.articles
  add column if not exists wp_category_id bigint,
  add column if not exists wp_category_name text;

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
  w.has_amazon_keys
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

-- Make the API notice the new columns right away.
notify pgrst, 'reload schema';
