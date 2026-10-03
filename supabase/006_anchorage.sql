-- Anchorage, AK region: any field, $85K+ floor (dashboard), federal (USAJobs) + all employers (Adzuna).
alter table public.sources add column if not exists region text;
alter table public.sources add column if not exists min_interval_hours int not null default 0;
alter table public.sources drop constraint if exists sources_kind_check;
alter table public.sources add constraint sources_kind_check
  check (kind in ('greenhouse','lever','ashby','amazon','workday','oracle','microsoft','usajobs','adzuna','manual'));

-- Feed API keys live in Vault. Add them once in the SQL editor (values not stored in this repo):
--   select vault.create_secret('<key>','usajobs_key');   select vault.create_secret('<email>','usajobs_email');
--   select vault.create_secret('<id>','adzuna_app_id');  select vault.create_secret('<key>','adzuna_app_key');
create or replace function private.get_feed_secret(n text) returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = n and n in ('usajobs_key','usajobs_email','adzuna_app_id','adzuna_app_key');
$$;
create or replace function public.get_feed_secret(n text) returns text
language sql stable security definer set search_path = '' as $$ select private.get_feed_secret(n); $$;
revoke all on function public.get_feed_secret(text) from public, anon, authenticated;
grant execute on function public.get_feed_secret(text) to service_role;

insert into public.sources (kind, slug, company, region, enabled, min_interval_hours) values
  ('usajobs','Anchorage, Alaska','Federal jobs (USAJobs)','anchorage',true,6),
  ('adzuna','Anchorage, AK|85000','Anchorage employers (Adzuna)','anchorage',true,24)
on conflict (kind, slug) do nothing;
