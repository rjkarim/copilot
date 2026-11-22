-- Old posts that Amazon has no products for are skipped (the post is left as it is)
-- instead of being listed as Failed. Their ids are remembered here so the updater
-- does not pick the same post again. Only the background writer reads this column.
alter table public.websites
  add column if not exists update_skipped bigint[] not null default '{}';

-- Move the updates that already failed for this reason out of the Failed list.
with moved as (
  delete from public.articles
   where kind = 'update'
     and status = 'failed'
     and error like 'Amazon returned no products%'
  returning website_id, wp_post_id
), grouped as (
  select website_id, array_agg(distinct wp_post_id) as ids
    from moved where wp_post_id is not null group by website_id
)
update public.websites w
   set update_skipped = (
     select coalesce(array_agg(distinct x), '{}') from unnest(w.update_skipped || g.ids) as x
   )
  from grouped g
 where g.website_id = w.id;

notify pgrst, 'reload schema';
