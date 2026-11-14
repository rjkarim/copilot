-- Update old WordPress posts (oldest first) + separate statistics for updates.
-- Run this once in Supabase Dashboard > SQL Editor (after 001-006).

-- An article row is either a brand-new article or the rewrite of an existing post.
alter table public.articles
  add column if not exists kind text not null default 'new' check (kind in ('new', 'update')),
  add column if not exists old_title text;
create index if not exists articles_kind_idx on public.articles (website_id, kind, status, seq);

-- Per-website settings and state for the old-post updater.
alter table public.websites
  add column if not exists update_enabled boolean not null default false,
  add column if not exists update_sleep_seconds integer not null default 60 check (update_sleep_seconds >= 0),
  add column if not exists update_product_count integer not null default 5 check (update_product_count between 1 and 10),
  add column if not exists update_include_faq boolean not null default true,
  add column if not exists update_next_run_at timestamptz not null default now(),
  -- Publish date (website's local time) of the last post taken; the next one is the oldest after it.
  add column if not exists update_cursor text,
  add column if not exists update_remaining integer,
  add column if not exists update_error text;
grant select (update_enabled, update_sleep_seconds, update_product_count, update_include_faq,
              update_next_run_at, update_cursor, update_remaining, update_error)
  on public.websites to authenticated;
grant update (update_enabled, update_sleep_seconds, update_product_count, update_include_faq,
              update_next_run_at, update_cursor, update_error)
  on public.websites to authenticated;

-- Dashboard view: the existing counters now cover new articles only; updates get their own.
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
  ucur.progress as update_progress
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

-- Scheduler: new articles and old-post updates run as two separate lanes per website.
create or replace function private.dispatch_articles() returns void
language plpgsql security definer set search_path = public, private as $$
declare
  fn_url text;
  secret text;
  rec record;
begin
  select value into fn_url from private.config where key = 'function_url';
  select value into secret from private.config where key = 'worker_secret';
  if fn_url is null or secret is null then return; end if;

  update public.articles
     set status = 'failed', step = null, finished_at = now(),
         error = 'Timed out while writing. Click Retry to queue it again.'
   where status = 'writing' and started_at < now() - interval '10 minutes';

  -- Lane 1: the next queued keyword of each website.
  for rec in
    select (select a.id from public.articles a
             where a.website_id = w.id and a.kind = 'new' and a.status = 'queued'
             order by a.seq limit 1) as article_id
    from public.websites w
    where not w.paused
      and w.next_run_at <= now()
      and not exists (select 1 from public.articles a
                       where a.website_id = w.id and a.kind = 'new' and a.status = 'writing')
  loop
    continue when rec.article_id is null;
    update public.articles
       set status = 'writing', started_at = now(), finished_at = null, progress = 5,
           step = 'Starting', attempts = attempts + 1, error = null
     where id = rec.article_id and status = 'queued';
    if found then
      perform net.http_post(
        url := fn_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', secret),
        body := jsonb_build_object('action', 'write', 'article_id', rec.article_id),
        timeout_milliseconds := 10000
      );
    end if;
  end loop;

  -- Lane 2: the next old post to update, for websites where updating is switched on.
  for rec in
    select w.id as website_id
    from public.websites w
    where w.update_enabled
      and w.update_next_run_at <= now()
      and not exists (select 1 from public.articles a
                       where a.website_id = w.id and a.kind = 'update' and a.status = 'writing')
  loop
    -- Hold the lane for up to 10 minutes; the writer sets the real sleep time when it finishes.
    update public.websites set update_next_run_at = now() + interval '10 minutes' where id = rec.website_id;
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', secret),
      body := jsonb_build_object('action', 'update_next', 'website_id', rec.website_id),
      timeout_milliseconds := 10000
    );
  end loop;
end $$;

-- Statistics, now split by kind ('new' or 'update').
drop function if exists public.article_stats(timestamptz);
drop function if exists public.article_timeline(timestamptz, text);

create or replace function public.article_stats(since timestamptz, kind text default 'new')
returns table (
  website_id uuid, website text,
  completed int, failed int,
  words_total bigint,
  tokens_total bigint, tokens_articles int,
  seconds_total numeric
)
language sql stable security invoker set search_path = public as $$
  select
    w.id, w.name,
    count(*) filter (where a.status = 'completed')::int,
    count(*) filter (where a.status = 'failed')::int,
    coalesce(sum(a.word_count) filter (where a.status = 'completed'), 0)::bigint,
    coalesce(sum(a.tokens_in + a.tokens_out) filter (where a.status = 'completed' and a.tokens_out is not null), 0)::bigint,
    count(*) filter (where a.status = 'completed' and a.tokens_out is not null)::int,
    coalesce(sum(extract(epoch from a.finished_at - a.started_at)) filter (where a.status = 'completed'), 0)
  from public.websites w
  left join public.articles a
    on a.website_id = w.id and a.finished_at >= since and a.status in ('completed', 'failed')
   and a.kind = article_stats.kind
  group by w.id, w.name
  order by w.name;
$$;

create or replace function public.article_timeline(since timestamptz, bucket text, kind text default 'new')
returns table (bucket_start timestamptz, completed int)
language sql stable security invoker set search_path = public as $$
  select date_trunc(case when bucket = 'day' then 'day' else 'hour' end, a.finished_at), count(*)::int
  from public.articles a
  where a.status = 'completed' and a.finished_at >= since and a.kind = article_timeline.kind
  group by 1
  order by 1;
$$;

grant execute on function public.article_stats(timestamptz, text) to authenticated;
grant execute on function public.article_timeline(timestamptz, text, text) to authenticated;

-- Make the API notice the changes right away.
notify pgrst, 'reload schema';
