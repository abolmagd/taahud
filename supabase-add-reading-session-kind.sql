-- Taahud: add reading records alongside mutun recitation.
-- Run once in the Supabase SQL Editor after supabase-add-mutun-session-fields.sql.

begin;

alter table public.sessions
  add column if not exists session_kind text not null default 'recitation',
  add column if not exists matn_name text;

do $$
declare
  check_name text;
begin
  for check_name in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'sessions'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%session_kind%'
  loop
    execute format('alter table public.sessions drop constraint if exists %I', check_name);
  end loop;
end $$;

alter table public.sessions
  add constraint sessions_session_kind_check
  check (session_kind in ('recitation','mutun','reading'));

create index if not exists sessions_session_kind_idx
  on public.sessions (session_kind)
  where deleted_at is null;

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
  p_session_date date,
  p_session_kind text default 'recitation',
  p_matn_name text default null
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
  session_kind text := coalesce(nullif(trim(p_session_kind), ''), 'recitation');
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

  select * into existing
  from public.sessions
  where client_request_id = p_client_request_id
    and student_id = sid
    and deleted_at is null
  limit 1;
  if existing.id is not null then
    return jsonb_build_object('id', existing.id, 'pointsAwarded', existing.points_awarded,
      'listenerPointsAwarded', existing.listener_points_awarded, 'sessionDate', existing.session_date,
      'sessionKind', coalesce(existing.session_kind, 'recitation'), 'matnName', existing.matn_name, 'duplicate', true);
  end if;

  if session_kind not in ('recitation', 'mutun', 'reading') then
    raise exception 'invalid_session_kind' using errcode = 'P0001';
  end if;
  if session_kind = 'reading' and trim(coalesce(p_matn_name, '')) = '' then
    raise exception 'missing_book_name' using errcode = 'P0001';
  end if;
  if p_listener_type not in ('student', 'outside', 'listening_only') then
    raise exception 'invalid_listener_type' using errcode = 'P0001';
  end if;
  if session_kind in ('mutun', 'reading') and p_listener_type <> 'outside' then
    raise exception 'invalid_listener_type' using errcode = 'P0001';
  end if;
  if p_pages is null or p_pages <= 0 or p_pages > 100 then
    raise exception 'invalid_pages' using errcode = 'P0001';
  end if;
  if p_method not in ('تليجرام','واتس','مكالمة هاتفية','جوجل ميت','مقابلة','استماع','تسميع متن','قراءة','أخرى') then
    raise exception 'invalid_method' using errcode = 'P0001';
  end if;
  if session_kind = 'mutun' and p_satisfaction not in ('متقن','متوسط','يحتاج إلى إعادة') then
    raise exception 'invalid_satisfaction' using errcode = 'P0001';
  end if;
  if session_kind = 'reading' and p_satisfaction <> 'قراءة' then
    raise exception 'invalid_satisfaction' using errcode = 'P0001';
  end if;
  if session_kind = 'recitation' and p_satisfaction not in ('نعم تماما','يحتاج إلى مزيد من الضبط','وردي كان ورد استماع') then
    raise exception 'invalid_satisfaction' using errcode = 'P0001';
  end if;
  if session_kind in ('mutun', 'reading') and trim(coalesce(p_notes, '')) = '' then
    raise exception 'missing_required_fields' using errcode = 'P0001';
  end if;

  if p_session_timing = 'today' then
    effective_day := local_today;
  elsif session_kind = 'recitation' and p_session_timing = 'previous' and p_session_date between local_today - 3 and local_today - 1 then
    effective_day := p_session_date;
  else
    raise exception 'invalid_session_date' using errcode = 'P0001';
  end if;

  if p_listener_type = 'student' then
    select * into listener
    from public.students
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
    session_kind, matn_name, method, satisfaction, notes, points_awarded, listener_points_awarded,
    session_date, session_timing, client_request_id)
  values (reciter.id, p_listener_type, case when p_listener_type = 'student' then listener.id end,
    p_pages, case when session_kind = 'recitation' then nullif(trim(p_surah_range), '') end,
    session_kind, case when session_kind = 'reading' then nullif(trim(p_matn_name), '') end,
    p_method, p_satisfaction, nullif(trim(p_notes), ''),
    reciter_points, listener_points, effective_day, p_session_timing, p_client_request_id)
  returning id into inserted_id;

  return jsonb_build_object('id', inserted_id, 'pointsAwarded', reciter_points,
    'listenerPointsAwarded', listener_points, 'sessionDate', effective_day,
    'sessionKind', session_kind, 'matnName', case when session_kind = 'reading' then nullif(trim(p_matn_name), '') end,
    'duplicate', false);
exception when unique_violation then
  select * into existing
  from public.sessions
  where client_request_id = p_client_request_id
    and student_id = sid
    and deleted_at is null
  limit 1;
  if existing.id is null then
    raise exception 'duplicate_request_id' using errcode = 'P0001';
  end if;
  return jsonb_build_object('id', existing.id, 'pointsAwarded', existing.points_awarded,
    'listenerPointsAwarded', existing.listener_points_awarded, 'sessionDate', existing.session_date,
    'sessionKind', coalesce(existing.session_kind, 'recitation'), 'matnName', existing.matn_name, 'duplicate', true);
end;
$$;

grant execute on function public.record_student_session(text,uuid,text,text,numeric,text,text,text,text,text,date,text,text)
  to anon, authenticated;

create or replace function public.admin_update_session(
  target_session_id uuid,
  p_pages numeric,
  p_surah_range text,
  p_method text,
  p_satisfaction text,
  p_notes text,
  p_session_date date,
  p_points_awarded integer,
  p_listener_points_awarded integer,
  change_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old_row public.sessions%rowtype;
  row_kind text;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  select * into old_row from public.sessions where id = target_session_id and deleted_at is null;
  if old_row.id is null then raise exception 'session_not_found' using errcode = 'P0001'; end if;
  row_kind := coalesce(old_row.session_kind, 'recitation');

  if p_pages <= 0 or p_pages > 100 or p_session_date > public.taahud_current_local_date()
    or p_points_awarded < 0 or p_listener_points_awarded < 0 then
    raise exception 'invalid_session_values' using errcode = 'P0001';
  end if;
  if p_method not in ('تليجرام','واتس','مكالمة هاتفية','جوجل ميت','مقابلة','استماع','تسميع متن','قراءة','أخرى') then
    raise exception 'invalid_session_values' using errcode = 'P0001';
  end if;
  if row_kind = 'mutun' and p_satisfaction not in ('متقن','متوسط','يحتاج إلى إعادة') then
    raise exception 'invalid_session_values' using errcode = 'P0001';
  end if;
  if row_kind = 'reading' and p_satisfaction <> 'قراءة' then
    raise exception 'invalid_session_values' using errcode = 'P0001';
  end if;
  if row_kind = 'recitation'
    and p_satisfaction not in ('نعم تماما','يحتاج إلى مزيد من الضبط','وردي كان ورد استماع') then
    raise exception 'invalid_session_values' using errcode = 'P0001';
  end if;
  update public.sessions
  set pages = p_pages,
      surah_range = case when row_kind = 'recitation' then nullif(trim(p_surah_range), '') else old_row.surah_range end,
      method = p_method,
      satisfaction = p_satisfaction,
      notes = nullif(trim(p_notes), ''),
      session_date = p_session_date,
      points_awarded = p_points_awarded,
      listener_points_awarded = p_listener_points_awarded,
      updated_at = now(),
      updated_by = auth.uid()
  where id = target_session_id;
  insert into public.admin_audit_log(admin_id,action,entity_type,entity_id,old_data,new_data,reason)
  values(auth.uid(),'update','session',target_session_id,to_jsonb(old_row),
    jsonb_build_object('pages',p_pages,'method',p_method,'satisfaction',p_satisfaction,'sessionDate',p_session_date,
      'pointsAwarded',p_points_awarded,'listenerPointsAwarded',p_listener_points_awarded),nullif(trim(change_reason),''));
end;
$$;

revoke execute on function public.admin_update_session(uuid,numeric,text,text,text,text,date,integer,integer,text) from public, anon;
grant execute on function public.admin_update_session(uuid,numeric,text,text,text,text,date,integer,integer,text)
  to authenticated;

commit;
