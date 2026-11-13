-- Lets you use any OpenAI-compatible AI provider (custom API address).
-- Run this once in Supabase Dashboard > SQL Editor.

alter table public.settings
  add column if not exists openai_base_url text not null default 'https://api.openai.com/v1';

grant select (openai_base_url) on public.settings to authenticated;
grant update (openai_base_url) on public.settings to authenticated;

-- Make the API notice the new columns right away.
notify pgrst, 'reload schema';
