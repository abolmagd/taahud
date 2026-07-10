-- ═══════════════════════════════════════════════════════════════
-- Ta'ahud Database Schema
-- Go to Supabase Dashboard → SQL Editor → New Query and paste this.
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.students (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz default now()
);

create table if not exists public.sessions (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.students(id),
  listener_type       text not null check (listener_type in ('student','outside','listening_only')),
  listener_student_id uuid references public.students(id),
  pages               numeric not null check (pages >= 0),
  surah_range         text,
  method              text not null,
  satisfaction        text not null,
  notes               text,
  points_awarded      integer not null default 0,
  listener_points_awarded integer not null default 0,
  created_at          timestamptz default now()
);

create table if not exists public.settings (
  key   text primary key,
  value jsonb not null
);

insert into public.settings (key, value)
values ('point_rules', '{"dailyCheckin": 5, "reciterPage": 2, "listenerPage": 1}'::jsonb)
on conflict (key) do nothing;

alter table public.sessions
  add column if not exists listener_points_awarded integer not null default 0;

create index if not exists sessions_student_id_idx on public.sessions (student_id);
create index if not exists sessions_listener_student_id_idx on public.sessions (listener_student_id);
create index if not exists sessions_created_at_idx on public.sessions (created_at);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'students'
    ) then
      alter publication supabase_realtime add table public.students;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sessions'
    ) then
      alter publication supabase_realtime add table public.sessions;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'settings'
    ) then
      alter publication supabase_realtime add table public.settings;
    end if;
  end if;
end $$;

create or replace function public.has_student_session_between(
  checked_student_id uuid,
  range_start timestamptz,
  range_end timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sessions
    where (student_id = checked_student_id or listener_student_id = checked_student_id)
      and created_at >= range_start
      and created_at < range_end
  );
$$;

grant execute on function public.has_student_session_between(uuid, timestamptz, timestamptz)
  to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Row Level Security
--
-- There is no student login anywhere in this app — students are
-- anonymous (anon key) and identify themselves only by picking a
-- code from a public dropdown. The single admin account is the only
-- thing that ever authenticates, so "authenticated" == "admin" here;
-- no separate is_admin() flag/table is needed (unlike the SIRIUS
-- MCQ project, which has many authenticated non-admin users).
-- ═══════════════════════════════════════════════════════════════

alter table public.students enable row level security;
alter table public.sessions enable row level security;
alter table public.settings enable row level security;

drop policy if exists "anyone_select_students" on public.students;
drop policy if exists "admin_write_students"   on public.students;
create policy "anyone_select_students" on public.students
  for select to anon, authenticated using (true);
create policy "admin_write_students" on public.students
  for all to authenticated using (true) with check (true);

drop policy if exists "anyone_insert_sessions" on public.sessions;
drop policy if exists "admin_read_sessions"     on public.sessions;
drop policy if exists "admin_write_sessions"    on public.sessions;
create policy "anyone_insert_sessions" on public.sessions
  for insert to anon, authenticated with check (true);
create policy "admin_read_sessions" on public.sessions
  for select to authenticated using (true);
create policy "admin_write_sessions" on public.sessions
  for all to authenticated using (true) with check (true);

drop policy if exists "anyone_select_settings" on public.settings;
drop policy if exists "admin_write_settings"   on public.settings;
create policy "anyone_select_settings" on public.settings
  for select to anon, authenticated using (true);
create policy "admin_write_settings" on public.settings
  for all to authenticated using (true) with check (true);
