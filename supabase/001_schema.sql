-- Job Hunt: schema, security, realtime
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Who may use the app. One row per allowed login email.
create table public.app_owner (
  email text primary key
);
insert into public.app_owner (email) values ('graffitiboy98@gmail.com');

create or replace function public.is_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.app_owner o
    where lower(o.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

-- Job feeds the ingest function pulls from
create table public.sources (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('greenhouse','lever','ashby','amazon','manual')),
  slug text not null,              -- board slug, or search query for amazon
  company text not null,
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_status text,
  last_count int,
  last_error text,
  unique (kind, slug)
);

-- Every posting we know about
create table public.postings (
  id uuid primary key default gen_random_uuid(),
  source_id bigint references public.sources(id) on delete set null,
  external_id text not null,
  company text not null,
  title text not null,
  location text,
  url text not null,
  lane text,                       -- Data Center | ServiceNow | IT Support | Sysadmin
  pay text,
  description text,
  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_checked_at timestamptz,
  is_open boolean not null default true,
  closed_at timestamptz,
  close_reason text,
  score int,                       -- 0-100
  fit text,                        -- Strong | Good | Stretch
  matched text[] default '{}',
  gaps text[] default '{}',
  why text,
  years_required int,
  unique (source_id, external_id)
);
create index postings_open_score_idx on public.postings (is_open, score desc);
create index postings_source_idx on public.postings (source_id);

-- Sultan's own progress on each posting
create table public.applications (
  posting_id uuid primary key references public.postings(id) on delete cascade,
  status text not null default 'Saved' check (status in ('Saved','Applied','Interview','Offer','Closed','Not interested')),
  notes text,
  applied_at date,
  resume_folder text,
  updated_at timestamptz not null default now()
);

-- Run log so the dashboard can show "last updated"
create table public.runs (
  id bigint generated always as identity primary key,
  kind text not null,              -- ingest | verify
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  new_count int default 0,
  closed_count int default 0,
  checked_count int default 0,
  errors text[] default '{}'
);

-- Row level security: only the owner can read or change anything.
alter table public.app_owner enable row level security;
alter table public.sources enable row level security;
alter table public.postings enable row level security;
alter table public.applications enable row level security;
alter table public.runs enable row level security;

create policy "owner reads sources" on public.sources for select to authenticated using ((select private.is_owner()));
create policy "owner reads postings" on public.postings for select to authenticated using ((select private.is_owner()));
create policy "owner reads runs" on public.runs for select to authenticated using ((select private.is_owner()));
create policy "owner reads applications" on public.applications for select to authenticated using ((select private.is_owner()));
create policy "owner inserts applications" on public.applications for insert to authenticated with check ((select private.is_owner()));
create policy "owner updates applications" on public.applications for update to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));
-- app_owner: no policies -> invisible to clients; only service role / SQL editor can change it.

-- Realtime
alter publication supabase_realtime add table public.postings, public.applications, public.runs;
