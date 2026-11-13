-- Statistics page: AI tokens per article + summary queries.
-- Run this once in Supabase Dashboard > SQL Editor (after 001-005).

-- Tokens the AI provider reported for writing each article (input and output).
alter table public.articles
  add column if not exists tokens_in integer,
  add column if not exists tokens_out integer;

-- Per-website totals for articles finished since a given moment.
-- Runs with the caller's own permissions, so everyone only sees their own data.
create or replace function public.article_stats(since timestamptz)
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
  group by w.id, w.name
  order by w.name;
$$;

-- Completed articles per hour or per day, for the timeline chart.
create or replace function public.article_timeline(since timestamptz, bucket text)
returns table (bucket_start timestamptz, completed int)
language sql stable security invoker set search_path = public as $$
  select date_trunc(case when bucket = 'day' then 'day' else 'hour' end, a.finished_at), count(*)::int
  from public.articles a
  where a.status = 'completed' and a.finished_at >= since
  group by 1
  order by 1;
$$;

grant execute on function public.article_stats(timestamptz) to authenticated;
grant execute on function public.article_timeline(timestamptz, text) to authenticated;

-- Make the API notice the changes right away.
notify pgrst, 'reload schema';
