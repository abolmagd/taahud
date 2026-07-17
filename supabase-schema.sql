-- ═══════════════════════════════════════════════════════════════
-- Ta'ahud Database Schema
-- Go to Supabase Dashboard → SQL Editor → New Query and paste this.
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.students (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz default now()
);

alter table public.students
  add column if not exists password_hash text,
  add column if not exists password_changed_at timestamptz;

update public.students
set password_hash = extensions.crypt('123456789', extensions.gen_salt('bf'))
where password_hash is null;

alter table public.students
  alter column password_hash set default extensions.crypt('123456789', extensions.gen_salt('bf')),
  alter column password_hash set not null;

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
  session_date        date not null default ((now() at time zone 'Africa/Cairo')::date),
  session_timing      text not null default 'today' check (session_timing in ('today','previous')),
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

alter table public.sessions
  add column if not exists session_date date not null default ((now() at time zone 'Africa/Cairo')::date),
  add column if not exists session_timing text not null default 'today'
    check (session_timing in ('today','previous'));

create index if not exists sessions_student_id_idx on public.sessions (student_id);
create index if not exists sessions_listener_student_id_idx on public.sessions (listener_student_id);
create index if not exists sessions_created_at_idx on public.sessions (created_at);
create index if not exists sessions_session_date_idx on public.sessions (session_date);

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
      and session_date >= range_start::date
      and session_date < range_end::date
  );
$$;

grant execute on function public.has_student_session_between(uuid, timestamptz, timestamptz)
  to anon, authenticated;

create or replace function public.taahud_current_local_date()
returns date
language sql
stable
as $$
  select (now() at time zone 'Africa/Cairo')::date;
$$;

create or replace function public.student_has_session_on(
  checked_student_id uuid,
  checked_day date
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
      and session_date = checked_day
  );
$$;

create or replace function public.should_award_daily_checkin(
  checked_student_id uuid,
  checked_day date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    not public.student_has_session_on(checked_student_id, checked_day)
    and (
      not exists (
        select 1
        from public.sessions
        where (student_id = checked_student_id or listener_student_id = checked_student_id)
          and session_date < checked_day
      )
      or public.student_has_session_on(checked_student_id, checked_day - 1)
    );
$$;

create or replace function public.authenticate_student(
  auth_code text,
  auth_password text
)
returns table (
  id uuid,
  code text,
  name text,
  must_change_password boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.code, s.name, s.password_changed_at is null
  from public.students s
  where s.active = true
    and s.code = trim(auth_code)
    and s.password_hash = extensions.crypt(auth_password, s.password_hash)
  limit 1;
$$;

drop function if exists public.change_student_password(text, text, text);

create or replace function public.change_student_password(
  auth_code text,
  old_password text,
  new_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_student public.students%rowtype;
begin
  if length(coalesce(new_password, '')) < 6 then
    raise exception 'weak_password' using errcode = 'P0001';
  end if;

  update public.students s
  set password_hash = extensions.crypt(new_password, extensions.gen_salt('bf')),
      password_changed_at = now()
  where s.active = true
    and s.code = trim(auth_code)
    and s.password_hash = extensions.crypt(old_password, s.password_hash)
  returning s.*
  into changed_student;

  if changed_student.id is null then
    raise exception 'invalid_login' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'id', changed_student.id,
    'code', changed_student.code,
    'name', changed_student.name,
    'must_change_password', false
  );
end;
$$;

drop function if exists public.reset_student_password(uuid);

create or replace function public.reset_student_password(
  target_student_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_student public.students%rowtype;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'admin_required' using errcode = 'P0001';
  end if;

  update public.students s
  set password_hash = extensions.crypt('123456789', extensions.gen_salt('bf')),
      password_changed_at = null
  where s.id = target_student_id
  returning s.*
  into changed_student;

  if changed_student.id is null then
    raise exception 'student_not_found' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'id', changed_student.id,
    'code', changed_student.code,
    'name', changed_student.name,
    'must_change_password', true
  );
end;
$$;

create or replace function public.record_student_session(
  auth_code text,
  auth_password text,
  p_listener_type text,
  p_listener_code text,
  p_pages numeric,
  p_surah_range text,
  p_method text,
  p_satisfaction text,
  p_notes text,
  p_session_timing text,
  p_session_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  reciter public.students%rowtype;
  listener public.students%rowtype;
  rules jsonb;
  local_today date := public.taahud_current_local_date();
  effective_day date;
  daily_points integer := 5;
  reciter_page_points integer := 2;
  listener_page_points integer := 1;
  award_reciter_daily boolean;
  award_listener_daily boolean := false;
  reciter_points integer;
  listener_points integer := 0;
  inserted_id uuid;
begin
  select *
  into reciter
  from public.students s
  where s.active = true
    and s.code = trim(auth_code)
    and s.password_hash = extensions.crypt(auth_password, s.password_hash)
  limit 1;

  if reciter.id is null then
    raise exception 'invalid_login' using errcode = 'P0001';
  end if;

  if reciter.password_changed_at is null then
    raise exception 'password_change_required' using errcode = 'P0001';
  end if;

  if p_listener_type not in ('student', 'outside', 'listening_only') then
    raise exception 'invalid_listener_type' using errcode = 'P0001';
  end if;

  if p_pages is null or p_pages < 0 then
    raise exception 'invalid_pages' using errcode = 'P0001';
  end if;

  if coalesce(p_method, '') = '' or coalesce(p_satisfaction, '') = '' then
    raise exception 'missing_required_fields' using errcode = 'P0001';
  end if;

  if p_session_timing = 'today' then
    effective_day := local_today;
  elsif p_session_timing = 'previous' and p_session_date is not null and p_session_date < local_today then
    effective_day := p_session_date;
  else
    raise exception 'invalid_session_date' using errcode = 'P0001';
  end if;

  if p_listener_type = 'student' then
    select *
    into listener
    from public.students s
    where s.active = true and s.code = trim(p_listener_code)
    limit 1;

    if listener.id is null then
      raise exception 'invalid_listener' using errcode = 'P0001';
    end if;
  end if;

  select value into rules
  from public.settings
  where key = 'point_rules';

  if rules is not null then
    daily_points := greatest(0, coalesce((rules->>'dailyCheckin')::integer, daily_points));
    reciter_page_points := greatest(0, coalesce((rules->>'reciterPage')::integer, reciter_page_points));
    listener_page_points := greatest(0, coalesce((rules->>'listenerPage')::integer, listener_page_points));
  end if;

  award_reciter_daily := public.should_award_daily_checkin(reciter.id, effective_day);
  if p_listener_type = 'student' then
    award_listener_daily :=
      case
        when listener.id = reciter.id then award_reciter_daily
        else public.should_award_daily_checkin(listener.id, effective_day)
      end;
  end if;

  reciter_points := (case when award_reciter_daily then daily_points else 0 end)
    + trunc(p_pages * reciter_page_points)::integer;

  if p_listener_type = 'student' then
    listener_points := (case when award_listener_daily then daily_points else 0 end)
      + trunc(p_pages * listener_page_points)::integer;
  end if;

  insert into public.sessions (
    student_id,
    listener_type,
    listener_student_id,
    pages,
    surah_range,
    method,
    satisfaction,
    notes,
    points_awarded,
    listener_points_awarded,
    session_date,
    session_timing
  )
  values (
    reciter.id,
    p_listener_type,
    case when p_listener_type = 'student' then listener.id else null end,
    p_pages,
    nullif(p_surah_range, ''),
    p_method,
    p_satisfaction,
    nullif(p_notes, ''),
    reciter_points,
    listener_points,
    effective_day,
    p_session_timing
  )
  returning id into inserted_id;

  return jsonb_build_object(
    'id', inserted_id,
    'pointsAwarded', reciter_points,
    'listenerPointsAwarded', listener_points,
    'sessionDate', effective_day
  );
end;
$$;

create or replace function public.get_student_profile(
  auth_code text,
  auth_password text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  student public.students%rowtype;
  sessions_json jsonb;
begin
  select *
  into student
  from public.students s
  where s.active = true
    and s.code = trim(auth_code)
    and s.password_hash = extensions.crypt(auth_password, s.password_hash)
  limit 1;

  if student.id is null then
    raise exception 'invalid_login' using errcode = 'P0001';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'createdAt', s.created_at,
        'sessionDate', s.session_date,
        'sessionTiming', s.session_timing,
        'role', case when s.student_id = student.id then 'reciter' else 'listener' end,
        'counterpart',
          case
            when s.student_id = student.id and s.listener_type = 'outside' then 'شخص آخر خارج تعاهُد'
            when s.student_id = student.id and s.listener_type = 'listening_only' then 'وِرد استماع'
            when s.student_id = student.id and listener.id is not null then listener.code || ' — ' || listener.name
            when reciter.id is not null then reciter.code || ' — ' || reciter.name
            else ''
          end,
        'pages', s.pages,
        'surahRange', s.surah_range,
        'method', s.method,
        'satisfaction', s.satisfaction,
        'notes', s.notes,
        'points', case when s.student_id = student.id then s.points_awarded else s.listener_points_awarded end
      )
      order by s.session_date desc, s.created_at desc
    ),
    '[]'::jsonb
  )
  into sessions_json
  from public.sessions s
  left join public.students reciter on reciter.id = s.student_id
  left join public.students listener on listener.id = s.listener_student_id
  where s.student_id = student.id
     or (s.listener_type = 'student' and s.listener_student_id = student.id);

  return jsonb_build_object(
    'student', jsonb_build_object('id', student.id, 'code', student.code, 'name', student.name),
    'mustChangePassword', student.password_changed_at is null,
    'sessions', sessions_json
  );
end;
$$;

drop function if exists public.complete_student_password_change(text, text, text);

create or replace function public.complete_student_password_change(
  auth_code text,
  old_password text,
  new_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_student public.students%rowtype;
begin
  if length(coalesce(new_password, '')) < 6 then
    raise exception 'weak_password' using errcode = 'P0001';
  end if;

  update public.students s
  set password_hash = extensions.crypt(new_password, extensions.gen_salt('bf')),
      password_changed_at = now()
  where s.active = true
    and s.code = trim(auth_code)
    and s.password_hash = extensions.crypt(old_password, s.password_hash)
  returning s.*
  into changed_student;

  if changed_student.id is null then
    raise exception 'invalid_login' using errcode = 'P0001';
  end if;

  return public.get_student_profile(auth_code, new_password);
end;
$$;

grant execute on function public.authenticate_student(text, text) to anon, authenticated;
grant execute on function public.change_student_password(text, text, text) to anon, authenticated;
grant execute on function public.complete_student_password_change(text, text, text) to anon, authenticated;
grant execute on function public.reset_student_password(uuid) to authenticated;
grant execute on function public.record_student_session(text, text, text, text, numeric, text, text, text, text, text, date)
  to anon, authenticated;
grant execute on function public.get_student_profile(text, text) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Row Level Security
--
-- Students authenticate through security-definer RPCs with code +
-- password, not through Supabase Auth. The single Supabase Auth
-- account remains the admin account, so "authenticated" == "admin"
-- for table policies. Anonymous users can read safe student columns
-- and settings, but they cannot insert sessions directly.
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

revoke select on public.students from anon, authenticated;
grant select (id, code, name, active, created_at, password_changed_at) on public.students to anon, authenticated;
grant insert, update, delete on public.students to authenticated;
