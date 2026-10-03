-- Annualized pay columns (hourly x 2080) for the $95K+ filter
alter table public.postings add column if not exists pay_min_yr int, add column if not exists pay_max_yr int;
-- New source types: Workday, Oracle Recruiting Cloud, Microsoft careers
alter table public.sources drop constraint if exists sources_kind_check;
alter table public.sources add constraint sources_kind_check check (kind in ('greenhouse','lever','ashby','amazon','workday','oracle','microsoft','manual'));
insert into public.sources (kind, slug, company) values
 ('workday','nvidia|wd5|NVIDIAExternalCareerSite','NVIDIA'), ('workday','ironmountain|wd5|iron-mountain-jobs','Iron Mountain'),
 ('workday','cyrusone|wd1|CyrusOneCareerPortal','CyrusOne'), ('workday','qtsdatacenters|wd5|QTS','QTS Data Centers'),
 ('workday','equinix|wd1|External|data center technician;data center operations;data center customer operations','Equinix'),
 ('oracle','eeho.fa.us2.oraclecloud.com|CX_45001|data center technician;data center operations','Oracle'),
 ('microsoft','datacenter technician;datacenter operations','Microsoft'),
 ('greenhouse','xai','xAI'), ('greenhouse','anthropic','Anthropic'), ('greenhouse','galaxydigitalservices','Galaxy (Helios data center)'),
 ('greenhouse','hut8','Hut 8'), ('ashby','vultr','Vultr'), ('ashby','openai','OpenAI')
on conflict (kind, slug) do nothing;
-- Run each company's board in its own function call (big boards no longer starve the rest)
create or replace function private.jobhunt_dispatch_ingest() returns int language plpgsql security definer set search_path = '' as $$
declare s record; n int := 0; secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'jobhunt_cron_secret';
  for s in select id from public.sources where enabled and kind <> 'manual' loop
    perform net.http_post(url := 'https://lqqzfissbdvsoapmplcv.supabase.co/functions/v1/jobs?mode=ingest&source=' || s.id,
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', secret), body := '{}'::jsonb, timeout_milliseconds := 150000);
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.alter_job((select jobid from cron.job where jobname = 'jobhunt-ingest'), command := 'select private.jobhunt_dispatch_ingest();');
select cron.schedule('jobhunt-prune-runs', '7 9 * * *', $$ delete from public.runs where started_at < now() - interval '14 days'; $$);

-- Hardware / NPI lane sources (contract manufacturers + Amazon hardware)
insert into public.sources (kind, slug, company) values
 ('workday','jabil|wd5|Jabil_Careers|NPI engineer;manufacturing engineer;process engineer;test engineer','Jabil'),
 ('workday','flextronics|wd1|Careers|NPI engineer;manufacturing engineer;process engineer;rack integration','Flex'),
 ('workday','hpe|wd5|Jobsathpe|NPI engineer;manufacturing engineer;rack integration;data center','HPE'),
 ('amazon','npi engineer|manufacturing engineer|hardware test engineer','Amazon (hardware)')
on conflict (kind, slug) do nothing;
