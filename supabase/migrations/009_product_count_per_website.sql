-- "Products to review per article" becomes a website setting that can be changed
-- at any time (like the sleep time) and applies to every keyword still waiting.
-- Run this once in Supabase Dashboard > SQL Editor (after 001-008).

alter table public.websites
  add column if not exists product_count integer not null default 5
  check (product_count between 1 and 10);
grant select (product_count) on public.websites to authenticated;
grant update (product_count) on public.websites to authenticated;

-- Start each website at the number its most recent keywords were added with.
update public.websites w
   set product_count = coalesce(
     (select a.product_count from public.articles a
       where a.website_id = w.id and a.kind = 'new'
       order by a.seq desc limit 1), 5);

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
  w.amazon_account_id,
  w.update_enabled, w.update_sleep_seconds, w.update_product_count, w.update_include_faq,
  w.update_next_run_at, w.update_cursor, w.update_remaining, w.update_error,
  coalesce(u.done, 0)::int as updates_done,
  coalesce(u.failed, 0)::int as updates_failed,
  ucur.keyword as update_keyword,
  ucur.step as update_step,
  ucur.progress as update_progress,
  w.product_count
from public.websites w
left join lateral (
  select
    count(*) filter (where a.status = 'queued') as queued,
    count(*) filter (where a.status = 'writing') as writing,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'failed') as failed
  from public.articles a where a.website_id = w.id and a.kind = 'new'
) s on true
left join lateral (
  select a.keyword, a.step, a.progress
  from public.articles a where a.website_id = w.id and a.kind = 'new' and a.status = 'writing'
  order by a.started_at desc limit 1
) cur on true
left join lateral (
  select
    count(*) filter (where a.status = 'completed') as done,
    count(*) filter (where a.status = 'failed') as failed
  from public.articles a where a.website_id = w.id and a.kind = 'update'
) u on true
left join lateral (
  select a.keyword, a.step, a.progress
  from public.articles a where a.website_id = w.id and a.kind = 'update' and a.status = 'writing'
  order by a.started_at desc limit 1
) ucur on true;
grant select on public.website_overview to authenticated;

-- Make the API notice the changes right away.
notify pgrst, 'reload schema';
