-- Taahud security and data-integrity upgrade (2026-07)
-- Run once in Supabase SQL Editor while signed in as the project owner.

begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.sessions
  add column if not exists client_request_id uuid,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid,
  add column if not exists delete_reason text,
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by uuid;

alter table public.students alter column password_hash drop default;

create unique index if not exists sessions_client_request_id_idx
  on public.sessions (client_request_id)
  where client_request_id is not null;

create index if not exists sessions_active_date_idx
  on public.sessions (session_date desc)
  where deleted_at is null;

create table if not exists public.student_auth_sessions (
  token_hash text primary key,
  student_id uuid not null references public.students(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists student_auth_sessions_student_idx
  on public.student_auth_sessions (student_id, expires_at);

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  old_data jsonb,
  new_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create or replace function public.taahud_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.role() = 'authenticated'
    and coalesce(auth.jwt() ->> 'email', '') = 'admin@taahud.local';
$$;

create or replace function public.taahud_current_local_date()
returns date
language sql
stable
as $$
  select (now() at time zone 'Africa/Cairo')::date;
$$;

create or replace function public.taahud_normalize_student_code(input_code text)
returns text
language sql
immutable
as $$
  with converted as (
    select translate(trim(coalesce(input_code, '')), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789') as value
  )
  select case
    when value ~ '^[0-9]+$' then coalesce(nullif(ltrim(value, '0'), ''), '0')
    else value
  end
  from converted;
$$;

create or replace function public.taahud_generate_temporary_password()
returns text
language sql
immutable
security definer
set search_path = public, extensions
as $$
  select '123456789'::text;
$$;

-- Accounts that have not completed their first password change use the shared
-- default requested by the program administrator.
update public.students
set password_hash = extensions.crypt('123456789', extensions.gen_salt('bf'))
where password_changed_at is null;

create or replace function public.taahud_student_id_for_token(access_token text)
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select sas.student_id
  from public.student_auth_sessions sas
  join public.students s on s.id = sas.student_id
  where sas.token_hash = encode(extensions.digest(coalesce(access_token, ''), 'sha256'), 'hex')
    and sas.expires_at > now()
    and s.active
  limit 1;
$$;

create or replace function public.student_has_session_on(checked_student_id uuid, checked_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sessions
    where deleted_at is null
      and (student_id = checked_student_id or listener_student_id = checked_student_id)
      and session_date = checked_day
  );
$$;

create or replace function public.should_award_daily_checkin(checked_student_id uuid, checked_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not public.student_has_session_on(checked_student_id, checked_day)
    and (
      not exists (
        select 1 from public.sessions
        where deleted_at is null
          and (student_id = checked_student_id or listener_student_id = checked_student_id)
          and session_date < checked_day
      )
      or public.student_has_session_on(checked_student_id, checked_day - 1)
    );
$$;

create or replace function public.student_login(auth_code text, auth_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  matched public.students%rowtype;
  raw_token text;
begin
  delete from public.student_auth_sessions where expires_at <= now();

  select * into matched
  from public.students s
  where s.active
    and public.taahud_normalize_student_code(s.code) = public.taahud_normalize_student_code(auth_code)
    and s.password_hash = extensions.crypt(auth_password, s.password_hash)
  limit 1;

  if matched.id is null then
    raise exception 'invalid_login' using errcode = 'P0001';
  end if;

  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.student_auth_sessions (token_hash, student_id, expires_at)
  values (encode(extensions.digest(raw_token, 'sha256'), 'hex'), matched.id, now() + interval '12 hours');

  return jsonb_build_object(
    'accessToken', raw_token,
    'expiresAt', now() + interval '12 hours',
    'student', jsonb_build_object('id', matched.id, 'code', matched.code, 'name', matched.name),
    'mustChangePassword', matched.password_changed_at is null
  );
end;
$$;

-- Remove the legacy password-on-every-request API after the token login exists.
drop function if exists public.authenticate_student(text, text);
drop function if exists public.change_student_password(text, text, text);
drop function if exists public.complete_student_password_change(text, text, text);
drop function if exists public.get_student_profile(text, text);

create or replace function public.student_logout(access_token text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  delete from public.student_auth_sessions
  where token_hash = encode(extensions.digest(coalesce(access_token, ''), 'sha256'), 'hex');
$$;

create or replace function public.student_change_password(access_token text, new_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  sid uuid := public.taahud_student_id_for_token(access_token);
  changed public.students%rowtype;
begin
  if sid is null then
    raise exception 'invalid_student_session' using errcode = 'P0001';
  end if;
  if length(coalesce(new_password, '')) < 8 then
    raise exception 'weak_password' using errcode = 'P0001';
  end if;

  update public.students
  set password_hash = extensions.crypt(new_password, extensions.gen_salt('bf')),
      password_changed_at = now()
  where id = sid
  returning * into changed;

  delete from public.student_auth_sessions
  where student_id = sid
    and token_hash <> encode(extensions.digest(access_token, 'sha256'), 'hex');

  return jsonb_build_object('id', changed.id, 'code', changed.code, 'name', changed.name);
end;
$$;

create or replace function public.list_active_student_codes(access_token text)
returns table (id uuid, code text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sid uuid := public.taahud_student_id_for_token(access_token);
begin
  if sid is null then
    raise exception 'invalid_student_session' using errcode = 'P0001';
  end if;
  return query
    select s.id, s.code from public.students s
    where s.active and s.id <> sid
    order by s.code;
end;
$$;

create or replace function public.get_student_profile(access_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sid uuid := public.taahud_student_id_for_token(access_token);
  current_student public.students%rowtype;
  sessions_json jsonb;
begin
  if sid is null then
    raise exception 'invalid_student_session' using errcode = 'P0001';
  end if;
  select * into current_student from public.students where id = sid;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'createdAt', s.created_at,
    'sessionDate', s.session_date,
    'sessionTiming', s.session_timing,
    'role', case when s.student_id = sid then 'reciter' else 'listener' end,
    'counterpart', case
      when s.student_id = sid and s.listener_type = 'outside' then 'شخص آخر خارج تعاهُد'
      when s.student_id = sid and s.listener_type = 'listening_only' then 'وِرد استماع'
      when s.student_id = sid and listener.id is not null then listener.code || ' - ' || listener.name
      when reciter.id is not null then reciter.code || ' - ' || reciter.name
      else '' end,
    'pages', s.pages,
    'surahRange', s.surah_range,
    'method', s.method,
    'satisfaction', s.satisfaction,
    'notes', s.notes,
    'points', case when s.student_id = sid then s.points_awarded else s.listener_points_awarded end
  ) order by s.session_date desc, s.created_at desc), '[]'::jsonb)
  into sessions_json
  from public.sessions s
  left join public.students reciter on reciter.id = s.student_id
  left join public.students listener on listener.id = s.listener_student_id
  where s.deleted_at is null
    and (s.student_id = sid or (s.listener_type = 'student' and s.listener_student_id = sid));

  return jsonb_build_object(
    'student', jsonb_build_object('id', current_student.id, 'code', current_student.code, 'name', current_student.name),
    'mustChangePassword', current_student.password_changed_at is null,
    'sessions', sessions_json
  );
end;
$$;

drop function if exists public.record_student_session(text, text, text, text, numeric, text, text, text, text, text, date);

create or replace function public.record_student_session(
  access_token text,
  p_client_request_id uuid,
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
  sid uuid := public.taahud_student_id_for_token(access_token);
  reciter public.students%rowtype;
  listener public.students%rowtype;
  existing public.sessions%rowtype;
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
  if sid is null then raise exception 'invalid_student_session' using errcode = 'P0001'; end if;
  select * into reciter from public.students where id = sid and active;
  if reciter.password_changed_at is null then raise exception 'password_change_required' using errcode = 'P0001'; end if;
  if p_client_request_id is null then raise exception 'missing_request_id' using errcode = 'P0001'; end if;

  select * into existing from public.sessions
  where client_request_id = p_client_request_id and student_id = sid limit 1;
  if existing.id is not null then
    return jsonb_build_object('id', existing.id, 'pointsAwarded', existing.points_awarded,
      'listenerPointsAwarded', existing.listener_points_awarded, 'sessionDate', existing.session_date, 'duplicate', true);
  end if;

  if p_listener_type not in ('student', 'outside', 'listening_only') then
    raise exception 'invalid_listener_type' using errcode = 'P0001';
  end if;
  if p_pages is null or p_pages <= 0 or p_pages > 100 then
    raise exception 'invalid_pages' using errcode = 'P0001';
  end if;
  if p_method not in ('تليجرام','واتس','مكالمة هاتفية','جوجل ميت','مقابلة','استماع','أخرى') then
    raise exception 'invalid_method' using errcode = 'P0001';
  end if;
  if p_satisfaction not in ('نعم تماما','يحتاج إلى مزيد من الضبط','وردي كان ورد استماع') then
    raise exception 'invalid_satisfaction' using errcode = 'P0001';
  end if;

  if p_session_timing = 'today' then
    effective_day := local_today;
  elsif p_session_timing = 'previous' and p_session_date between local_today - 3 and local_today - 1 then
    effective_day := p_session_date;
  else
    raise exception 'invalid_session_date' using errcode = 'P0001';
  end if;

  if p_listener_type = 'student' then
    select * into listener from public.students
    where active
      and public.taahud_normalize_student_code(code) = public.taahud_normalize_student_code(p_listener_code)
    limit 1;
    if listener.id is null then raise exception 'invalid_listener' using errcode = 'P0001'; end if;
    if listener.id = reciter.id then raise exception 'self_listener_not_allowed' using errcode = 'P0001'; end if;
  end if;

  select value into rules from public.settings where key = 'point_rules';
  if rules is not null then
    daily_points := greatest(0, coalesce((rules->>'dailyCheckin')::integer, daily_points));
    reciter_page_points := greatest(0, coalesce((rules->>'reciterPage')::integer, reciter_page_points));
    listener_page_points := greatest(0, coalesce((rules->>'listenerPage')::integer, listener_page_points));
  end if;

  award_reciter_daily := public.should_award_daily_checkin(reciter.id, effective_day);
  if p_listener_type = 'student' then
    award_listener_daily := public.should_award_daily_checkin(listener.id, effective_day);
  end if;
  reciter_points := (case when award_reciter_daily then daily_points else 0 end)
    + trunc(p_pages * reciter_page_points)::integer;
  if p_listener_type = 'student' then
    listener_points := (case when award_listener_daily then daily_points else 0 end)
      + trunc(p_pages * listener_page_points)::integer;
  end if;

  insert into public.sessions (student_id, listener_type, listener_student_id, pages, surah_range,
    method, satisfaction, notes, points_awarded, listener_points_awarded, session_date, session_timing, client_request_id)
  values (reciter.id, p_listener_type, case when p_listener_type = 'student' then listener.id end,
    p_pages, nullif(trim(p_surah_range), ''), p_method, p_satisfaction, nullif(trim(p_notes), ''),
    reciter_points, listener_points, effective_day, p_session_timing, p_client_request_id)
  returning id into inserted_id;

  return jsonb_build_object('id', inserted_id, 'pointsAwarded', reciter_points,
    'listenerPointsAwarded', listener_points, 'sessionDate', effective_day, 'duplicate', false);
exception when unique_violation then
  select * into existing from public.sessions
  where client_request_id = p_client_request_id and student_id = sid limit 1;
  if existing.id is null then
    raise exception 'duplicate_request_id' using errcode = 'P0001';
  end if;
  return jsonb_build_object('id', existing.id, 'pointsAwarded', existing.points_awarded,
    'listenerPointsAwarded', existing.listener_points_awarded, 'sessionDate', existing.session_date, 'duplicate', true);
end;
$$;

create or replace function public.create_student_with_temp_password(p_code text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  temp_password text;
  created public.students%rowtype;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if trim(coalesce(p_code,'')) = '' or trim(coalesce(p_name,'')) = '' then
    raise exception 'missing_required_fields' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.students s
    where public.taahud_normalize_student_code(s.code) = public.taahud_normalize_student_code(p_code)
  ) then
    raise exception 'duplicate_student_code' using errcode = 'P0001';
  end if;
  temp_password := public.taahud_generate_temporary_password();
  insert into public.students (code, name, active, password_hash, password_changed_at)
  values (
    translate(trim(p_code), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
    trim(p_name), true, extensions.crypt(temp_password, extensions.gen_salt('bf')), null
  )
  returning * into created;
  insert into public.admin_audit_log(admin_id, action, entity_type, entity_id, new_data)
  values(auth.uid(), 'create', 'student', created.id, jsonb_build_object('code',created.code,'name',created.name));
  return jsonb_build_object('id',created.id,'code',created.code,'name',created.name,'temporaryPassword',temp_password);
end;
$$;

create or replace function public.reset_student_password(target_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  temp_password text;
  changed public.students%rowtype;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  temp_password := public.taahud_generate_temporary_password();
  update public.students set password_hash = extensions.crypt(temp_password, extensions.gen_salt('bf')),
    password_changed_at = null where id = target_student_id returning * into changed;
  if changed.id is null then raise exception 'student_not_found' using errcode = 'P0001'; end if;
  delete from public.student_auth_sessions where student_id = changed.id;
  insert into public.admin_audit_log(admin_id, action, entity_type, entity_id)
  values(auth.uid(), 'reset_password', 'student', changed.id);
  return jsonb_build_object('id',changed.id,'code',changed.code,'name',changed.name,'temporaryPassword',temp_password);
end;
$$;

create or replace function public.set_student_active(target_student_id uuid, next_active boolean, change_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare old_value boolean;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  select active into old_value from public.students where id = target_student_id;
  if old_value is null then raise exception 'student_not_found' using errcode = 'P0001'; end if;
  update public.students set active = next_active where id = target_student_id;
  if not next_active then delete from public.student_auth_sessions where student_id = target_student_id; end if;
  insert into public.admin_audit_log(admin_id,action,entity_type,entity_id,old_data,new_data,reason)
  values(auth.uid(),'set_active','student',target_student_id,jsonb_build_object('active',old_value),jsonb_build_object('active',next_active),nullif(trim(change_reason),''));
end;
$$;

create or replace function public.rotate_unclaimed_student_passwords()
returns table(code text, name text, temporary_password text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare row_student public.students%rowtype; temp_password text;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  for row_student in
    select s.* from public.students s
    where s.active and s.password_changed_at is null
    order by s.code
  loop
    temp_password := public.taahud_generate_temporary_password();
    update public.students set password_hash = extensions.crypt(temp_password, extensions.gen_salt('bf')) where id = row_student.id;
    delete from public.student_auth_sessions where student_id = row_student.id;
    code := row_student.code; name := row_student.name; temporary_password := temp_password;
    return next;
  end loop;
  insert into public.admin_audit_log(admin_id,action,entity_type,new_data)
  values(auth.uid(),'rotate_unclaimed_passwords','student',jsonb_build_object('completedAt',now()));
end;
$$;

create or replace function public.admin_update_session(
  target_session_id uuid, p_pages numeric, p_surah_range text, p_method text,
  p_satisfaction text, p_notes text, p_session_date date,
  p_points_awarded integer, p_listener_points_awarded integer, change_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare old_row public.sessions%rowtype;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  select * into old_row from public.sessions where id = target_session_id and deleted_at is null;
  if old_row.id is null then raise exception 'session_not_found' using errcode = 'P0001'; end if;
  if p_pages <= 0 or p_pages > 100 or p_session_date > public.taahud_current_local_date()
    or p_points_awarded < 0 or p_listener_points_awarded < 0 then
    raise exception 'invalid_session_values' using errcode = 'P0001';
  end if;
  if p_method not in ('تليجرام','واتس','مكالمة هاتفية','جوجل ميت','مقابلة','استماع','أخرى')
    or p_satisfaction not in ('نعم تماما','يحتاج إلى مزيد من الضبط','وردي كان ورد استماع') then
    raise exception 'invalid_session_values' using errcode = 'P0001';
  end if;
  update public.sessions set pages=p_pages, surah_range=nullif(trim(p_surah_range),''), method=p_method,
    satisfaction=p_satisfaction, notes=nullif(trim(p_notes),''), session_date=p_session_date,
    points_awarded=p_points_awarded, listener_points_awarded=p_listener_points_awarded,
    updated_at=now(), updated_by=auth.uid() where id=target_session_id;
  insert into public.admin_audit_log(admin_id,action,entity_type,entity_id,old_data,new_data,reason)
  values(auth.uid(),'update','session',target_session_id,to_jsonb(old_row),
    jsonb_build_object('pages',p_pages,'method',p_method,'satisfaction',p_satisfaction,'sessionDate',p_session_date,
      'pointsAwarded',p_points_awarded,'listenerPointsAwarded',p_listener_points_awarded),nullif(trim(change_reason),''));
end;
$$;

create or replace function public.admin_delete_session(target_session_id uuid, change_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare old_row public.sessions%rowtype;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if trim(coalesce(change_reason,'')) = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;
  select * into old_row from public.sessions where id=target_session_id and deleted_at is null;
  if old_row.id is null then raise exception 'session_not_found' using errcode = 'P0001'; end if;
  update public.sessions set deleted_at=now(), deleted_by=auth.uid(), delete_reason=trim(change_reason) where id=target_session_id;
  insert into public.admin_audit_log(admin_id,action,entity_type,entity_id,old_data,reason)
  values(auth.uid(),'delete','session',target_session_id,to_jsonb(old_row),trim(change_reason));
end;
$$;

create or replace function public.admin_reset_student_points(target_student_id uuid, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_student public.students%rowtype;
  removed_points bigint := 0;
  affected_sessions bigint := 0;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if trim(coalesce(change_reason,'')) = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;

  select * into target_student from public.students where id = target_student_id;
  if target_student.id is null then raise exception 'student_not_found' using errcode = 'P0001'; end if;

  lock table public.sessions in share row exclusive mode;

  select
    coalesce(sum(
      case when s.student_id = target_student_id then s.points_awarded::bigint else 0 end +
      case when s.listener_type = 'student' and s.listener_student_id = target_student_id
        then s.listener_points_awarded::bigint else 0 end
    ), 0),
    count(*)
  into removed_points, affected_sessions
  from public.sessions s
  where s.deleted_at is null
    and (
      (s.student_id = target_student_id and s.points_awarded <> 0)
      or (s.listener_type = 'student' and s.listener_student_id = target_student_id
        and s.listener_points_awarded <> 0)
    );

  update public.sessions s
  set points_awarded = case when s.student_id = target_student_id then 0 else s.points_awarded end,
      listener_points_awarded = case
        when s.listener_type = 'student' and s.listener_student_id = target_student_id then 0
        else s.listener_points_awarded
      end,
      updated_at = now(),
      updated_by = auth.uid()
  where s.deleted_at is null
    and (
      (s.student_id = target_student_id and s.points_awarded <> 0)
      or (s.listener_type = 'student' and s.listener_student_id = target_student_id
        and s.listener_points_awarded <> 0)
    );

  insert into public.admin_audit_log(admin_id,action,entity_type,entity_id,old_data,new_data,reason)
  values(
    auth.uid(),'reset_points','student',target_student_id,
    jsonb_build_object('points',removed_points,'affectedSessions',affected_sessions),
    jsonb_build_object('points',0),trim(change_reason)
  );

  return jsonb_build_object(
    'studentId',target_student.id,'code',target_student.code,'name',target_student.name,
    'removedPoints',removed_points,'affectedSessions',affected_sessions
  );
end;
$$;

create or replace function public.admin_reset_all_points(change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  removed_points bigint := 0;
  affected_sessions bigint := 0;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if trim(coalesce(change_reason,'')) = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;

  lock table public.sessions in share row exclusive mode;

  select
    coalesce(sum(s.points_awarded::bigint + s.listener_points_awarded::bigint), 0),
    count(*)
  into removed_points, affected_sessions
  from public.sessions s
  where s.deleted_at is null
    and (s.points_awarded <> 0 or s.listener_points_awarded <> 0);

  update public.sessions
  set points_awarded = 0,
      listener_points_awarded = 0,
      updated_at = now(),
      updated_by = auth.uid()
  where deleted_at is null
    and (points_awarded <> 0 or listener_points_awarded <> 0);

  insert into public.admin_audit_log(admin_id,action,entity_type,old_data,new_data,reason)
  values(
    auth.uid(),'reset_all_points','points',
    jsonb_build_object('points',removed_points,'affectedSessions',affected_sessions),
    jsonb_build_object('points',0),trim(change_reason)
  );

  return jsonb_build_object('removedPoints',removed_points,'affectedSessions',affected_sessions);
end;
$$;

alter table public.student_auth_sessions enable row level security;
alter table public.admin_audit_log enable row level security;

drop policy if exists "anyone_select_students" on public.students;
drop policy if exists "admin_write_students" on public.students;
drop policy if exists "admin_read_sessions" on public.sessions;
drop policy if exists "admin_write_sessions" on public.sessions;
drop policy if exists "admin_write_settings" on public.settings;
drop policy if exists "admin_read_students" on public.students;
drop policy if exists "admin_read_audit" on public.admin_audit_log;

create policy "admin_read_students" on public.students for select to authenticated using (public.taahud_is_admin());
create policy "admin_write_students" on public.students for all to authenticated using (public.taahud_is_admin()) with check (public.taahud_is_admin());
create policy "admin_read_sessions" on public.sessions for select to authenticated using (public.taahud_is_admin());
create policy "admin_write_sessions" on public.sessions for all to authenticated using (public.taahud_is_admin()) with check (public.taahud_is_admin());
create policy "admin_write_settings" on public.settings for all to authenticated using (public.taahud_is_admin()) with check (public.taahud_is_admin());
create policy "admin_read_audit" on public.admin_audit_log for select to authenticated using (public.taahud_is_admin());

revoke all on public.students from anon;
revoke all on public.sessions from anon;
revoke all on public.student_auth_sessions from anon, authenticated;
revoke all on public.admin_audit_log from anon, authenticated;
revoke execute on function public.has_student_session_between(uuid,timestamptz,timestamptz) from public, anon, authenticated;
revoke execute on function public.student_has_session_on(uuid,date) from public, anon, authenticated;
revoke execute on function public.should_award_daily_checkin(uuid,date) from public, anon, authenticated;
grant select, insert, update, delete on public.students to authenticated;
grant select, insert, update, delete on public.sessions to authenticated;
grant select on public.admin_audit_log to authenticated;

revoke execute on function public.taahud_generate_temporary_password() from public, anon, authenticated;
revoke execute on function public.taahud_student_id_for_token(text) from public, anon, authenticated;
revoke execute on function public.taahud_normalize_student_code(text) from public, anon, authenticated;
revoke execute on function public.taahud_is_admin() from public, anon, authenticated;
grant execute on function public.taahud_is_admin() to authenticated;
revoke execute on function public.create_student_with_temp_password(text,text) from public, anon;
revoke execute on function public.reset_student_password(uuid) from public, anon;
revoke execute on function public.set_student_active(uuid,boolean,text) from public, anon;
revoke execute on function public.rotate_unclaimed_student_passwords() from public, anon;
revoke execute on function public.admin_update_session(uuid,numeric,text,text,text,text,date,integer,integer,text) from public, anon;
revoke execute on function public.admin_delete_session(uuid,text) from public, anon;
revoke execute on function public.admin_reset_student_points(uuid,text) from public, anon;
revoke execute on function public.admin_reset_all_points(text) from public, anon;
grant execute on function public.student_login(text,text) to anon, authenticated;
grant execute on function public.student_logout(text) to anon, authenticated;
grant execute on function public.student_change_password(text,text) to anon, authenticated;
grant execute on function public.list_active_student_codes(text) to anon, authenticated;
grant execute on function public.get_student_profile(text) to anon, authenticated;
grant execute on function public.record_student_session(text,uuid,text,text,numeric,text,text,text,text,text,date) to anon, authenticated;
grant execute on function public.create_student_with_temp_password(text,text) to authenticated;
grant execute on function public.reset_student_password(uuid) to authenticated;
grant execute on function public.set_student_active(uuid,boolean,text) to authenticated;
grant execute on function public.rotate_unclaimed_student_passwords() to authenticated;
grant execute on function public.admin_update_session(uuid,numeric,text,text,text,text,date,integer,integer,text) to authenticated;
grant execute on function public.admin_delete_session(uuid,text) to authenticated;
grant execute on function public.admin_reset_student_points(uuid,text) to authenticated;
grant execute on function public.admin_reset_all_points(text) to authenticated;

-- Existing accounts that have not changed their password are reset to
-- 123456789. The forced-change screen still replaces it on first login.

commit;
