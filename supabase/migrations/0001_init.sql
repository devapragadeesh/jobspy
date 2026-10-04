-- jobspy schema. All access goes through the server-side secret key;
-- RLS is enabled with no policies so the publishable key can read nothing.

create table public.settings (
  id int primary key default 1 check (id = 1),
  resume_filename text,
  resume_text text,
  resume_profile jsonb,
  target_roles text[] not null default '{}',
  departments text[] not null default '{}',
  locations text[] not null default '{}',
  exclude_keywords text[] not null default '{}',
  min_score int not null default 60 check (min_score between 0 and 100),
  alert_to text,
  scan_interval_hours int not null default 48,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  careers_url text not null unique,
  ats_type text,
  ats_config jsonb,
  active boolean not null default true,
  research jsonb,
  researched_at timestamptz,
  last_scan_at timestamptz,
  last_scan_status text,
  last_scan_error text,
  consecutive_failures int not null default 0,
  health_alerted_at timestamptz,
  last_job_count int,
  created_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  external_key text not null,
  title text not null,
  location text,
  department text,
  url text not null,
  description text,
  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  missed_scans int not null default 0,
  closed_at timestamptz,
  closed_notified_at timestamptz,
  -- null = not triaged yet, false = filtered out, true = worth scoring/reporting
  relevant boolean,
  fit_score int check (fit_score between 0 and 100),
  fit_reason text,
  matched_skills text[] not null default '{}',
  gaps text[] not null default '{}',
  salary jsonb,
  status text not null default 'new'
    check (status in ('new', 'saved', 'applied', 'interviewing', 'rejected', 'dismissed')),
  notified_at timestamptz,
  unique (company_id, external_key)
);
create index jobs_company_open_idx on public.jobs (company_id) where closed_at is null;
create index jobs_triage_queue_idx on public.jobs (first_seen_at) where relevant is null and closed_at is null;
create index jobs_relevant_idx on public.jobs (fit_score desc nulls last) where relevant;

create table public.scan_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger text,
  stats jsonb,
  email_sent boolean not null default false,
  error text
);

alter table public.settings enable row level security;
alter table public.companies enable row level security;
alter table public.jobs enable row level security;
alter table public.scan_runs enable row level security;
