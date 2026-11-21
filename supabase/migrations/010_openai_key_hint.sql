-- Lets Settings show which AI key is saved without ever exposing it: only the
-- last 4 characters are readable from the browser; the key itself stays write-only.
alter table public.settings
  add column if not exists openai_key_hint text
  generated always as (nullif(right(coalesce(openai_api_key, ''), 4), '')) stored;

grant select (openai_key_hint) on public.settings to authenticated;

notify pgrst, 'reload schema';
