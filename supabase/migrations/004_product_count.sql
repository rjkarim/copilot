-- How many products a review article should cover (chosen when adding keywords).
-- Run this once in Supabase Dashboard > SQL Editor (after 001-003).

alter table public.articles
  add column if not exists product_count integer not null default 5
  check (product_count between 1 and 10);

-- Make the API notice the new column right away.
notify pgrst, 'reload schema';
