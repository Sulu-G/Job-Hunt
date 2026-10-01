-- Move helper functions out of the public API schema; pg_net into extensions
create schema if not exists private;
grant usage on schema private to authenticated, service_role;
create or replace function private.is_owner() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_owner o where lower(o.email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function private.is_owner() from public, anon;
grant execute on function private.is_owner() to authenticated;
-- (policies recreated to use private.is_owner(); see 001 for the policy list)
create or replace function private.check_cron_secret(s text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'jobhunt_cron_secret' and decrypted_secret = s and length(s) > 20);
$$;
revoke all on function private.check_cron_secret(text) from public, anon, authenticated;
grant execute on function private.check_cron_secret(text) to service_role;
create or replace function public.check_cron_secret(s text) returns boolean language sql stable security invoker set search_path = '' as $$ select private.check_cron_secret(s); $$;
revoke all on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;
drop extension if exists pg_net; create extension pg_net with schema extensions;
