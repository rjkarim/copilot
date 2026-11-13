-- AffiliWriter database setup.
-- Run this whole file once in Supabase Dashboard > SQL Editor.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null default '',
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "own profile" on public.profiles for all
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------- settings
-- One row per user. The secret columns can be written by the owner but never
-- read back by the browser (column-level grants below); only the background
-- writer (service role) reads them.
create table public.settings (
  user_id uuid primary key references auth.users on delete cascade,
  openai_api_key text,
  openai_model text not null default 'gpt-4o-mini',
  amazon_credential_id text,
  amazon_credential_secret text,
  amazon_version text not null default '3.1',
  has_openai_key boolean generated always as (coalesce(openai_api_key, '') <> '') stored,
  has_amazon_keys boolean generated always as
    (coalesce(amazon_credential_id, '') <> '' and coalesce(amazon_credential_secret, '') <> '') stored,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
create policy "own settings" on public.settings for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.settings from anon, authenticated;
grant select (user_id, openai_model, amazon_version, has_openai_key, has_amazon_keys, updated_at)
  on public.settings to authenticated;
grant update (openai_api_key, openai_model, amazon_credential_id, amazon_credential_secret, amazon_version, updated_at)
  on public.settings to authenticated;

-- ---------------------------------------------------------------- websites
create table public.websites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  url text not null,
  wp_username text not null default '',
  wp_app_password text,
  tracking_id text not null default '',
  marketplace text not null default 'www.amazon.com',
  language text not null default 'English',
  post_status text not null default 'draft' check (post_status in ('draft', 'publish')),
  sleep_seconds integer not null default 60 check (sleep_seconds >= 0),
  paused boolean not null default false,
  wp_published integer,
  wp_drafts integer,
  wp_synced_at timestamptz,
  wp_error text,
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  has_wp_password boolean generated always as (coalesce(wp_app_password, '') <> '') stored
);
alter table public.websites enable row level security;
create policy "own websites" on public.websites for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.websites from anon, authenticated;
grant select (id, user_id, name, url, wp_username, tracking_id, marketplace, language, post_status,
              sleep_seconds, paused, wp_published, wp_drafts, wp_synced_at, wp_error, next_run_at,
              created_at, has_wp_password)
  on public.websites to authenticated;
grant insert (id, name, url, wp_username, wp_app_password, tracking_id, marketplace, language,
              post_status, sleep_seconds, paused)
  on public.websites to authenticated;
grant update (name, url, wp_username, wp_app_password, tracking_id, marketplace, language,
              post_status, sleep_seconds, paused)
  on public.websites to authenticated;
grant delete on public.websites to authenticated;

-- ---------------------------------------------------------------- articles
-- Each keyword is one row. It is both the job queue and the finished article.
create table public.articles (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  website_id uuid not null references public.websites on delete cascade,
  keyword text not null,
  type text not null default 'review' check (type in ('review', 'informative')),
  status text not null default 'queued' check (status in ('queued', 'writing', 'completed', 'failed')),
  step text,
  progress integer not null default 0,
  title text,
  content_html text,
  word_count integer,
  wp_post_id bigint,
  wp_post_url text,
  wp_status text,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index articles_queue_idx on public.articles (website_id, status, seq);
alter table public.articles enable row level security;
create policy "own articles" on public.articles for all
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.websites w where w.id = website_id and w.user_id = auth.uid())
  );

-- ---------------------------------------------------------------- dashboard view
create view public.website_overview with (security_invoker = true) as
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
  cur.progress as current_progress
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

-- ---------------------------------------------------------------- new user setup
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
    values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
    on conflict do nothing;
  insert into public.settings (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Cover accounts that already existed before this file was run.
insert into public.profiles (id) select id from auth.users on conflict do nothing;
insert into public.settings (user_id) select id from auth.users on conflict do nothing;

-- ---------------------------------------------------------------- live updates
alter publication supabase_realtime add table public.articles;
alter publication supabase_realtime add table public.websites;

-- ---------------------------------------------------------------- background writer
-- private.config holds the Edge Function URL and the shared secret (see README step 4).
create schema if not exists private;
create table private.config (key text primary key, value text not null);

-- Runs every 30 seconds inside the database, so it keeps going when nobody is
-- logged in. For each website that is not paused, has finished its sleep time
-- and is not already writing, it takes the next queued keyword and hands it to
-- the "writer" Edge Function.
create function private.dispatch_articles() returns void
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

  for rec in
    select (select a.id from public.articles a
             where a.website_id = w.id and a.status = 'queued'
             order by a.seq limit 1) as article_id
    from public.websites w
    where not w.paused
      and w.next_run_at <= now()
      and not exists (select 1 from public.articles a
                       where a.website_id = w.id and a.status = 'writing')
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
end $$;

select cron.schedule('affiliwriter-dispatch', '30 seconds', 'select private.dispatch_articles()');
