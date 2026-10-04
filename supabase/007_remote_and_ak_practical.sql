-- Remote / hybrid track ($75K+ remote or Houston hybrid) and Alaska oil & gas source.
alter table public.postings add column if not exists work_mode text; -- remote | hybrid | onsite
alter table public.sources drop constraint if exists sources_kind_check;
alter table public.sources add constraint sources_kind_check
  check (kind in ('greenhouse','lever','ashby','amazon','workday','oracle','microsoft','usajobs','adzuna','remotive','himalayas','jobicy','remoteok','manual'));
insert into public.sources (kind, slug, company, region, enabled, min_interval_hours) values
  ('usajobs','remote:2210','Federal IT jobs (remote)','remote',true,6),
  ('adzuna','|75000|remote|help desk desktop servicenow administrator NOC sysadmin support technician','Remote IT jobs (Adzuna)','remote',true,24),
  ('adzuna','|75000|hybrid|help desk desktop servicenow administrator NOC sysadmin support technician','Hybrid IT jobs (Adzuna)','remote',true,24),
  ('remotive','all','Remotive (remote boards)','remote',true,24),
  ('himalayas','IT support;help desk;system administrator;servicenow;technical support;NOC','Himalayas (remote boards)','remote',true,12),
  ('jobicy','usa','Jobicy (remote boards)','remote',true,12),
  ('remoteok','all','RemoteOK (remote boards)','remote',true,12),
  ('adzuna','Alaska|85000||oil gas pipeline roustabout operator slope drilling wellsite field technician','Alaska oil & gas (Adzuna)','anchorage',true,24)
on conflict (kind, slug) do nothing;
