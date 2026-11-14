-- Articles that time out are retried automatically after 30 seconds
-- (up to 4 attempts in total) instead of going straight to Failed.
-- Run this once in Supabase Dashboard > SQL Editor (after 001-007).

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

  -- Stuck for more than 10 minutes: back into the queue (or Failed after the 4th attempt).
  for rec in
    update public.articles
       set status = case when attempts < 4 then 'queued' else 'failed' end,
           step = null, progress = 0,
           finished_at = case when attempts < 4 then null else now() end,
           error = case when attempts < 4
                        then 'Timed out while writing. Retrying automatically in 30 seconds (attempt ' || (attempts + 1) || ' of 4).'
                        else 'Timed out while writing, 4 times in a row. Click Retry to queue it again.' end
     where status = 'writing' and started_at < now() - interval '10 minutes'
    returning website_id, kind, status
  loop
    if rec.status = 'queued' then
      if rec.kind = 'new' then
        update public.websites set next_run_at = now() + interval '30 seconds' where id = rec.website_id;
      else
        update public.websites set update_next_run_at = now() + interval '30 seconds' where id = rec.website_id;
      end if;
    end if;
  end loop;

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
