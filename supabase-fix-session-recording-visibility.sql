-- Taahud: keep successful student submissions visible after soft-deleted retries.
-- Run this once in the Supabase SQL Editor for projects that already ran the
-- 2026-07 upgrade.

begin;

drop index if exists sessions_client_request_id_idx;
create unique index sessions_client_request_id_idx
  on public.sessions (client_request_id)
  where client_request_id is not null and deleted_at is null;

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

  select * into existing
  from public.sessions
  where client_request_id = p_client_request_id
    and student_id = sid
    and deleted_at is null
  limit 1;
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
    method, satisfaction, notes, points_awarded, listener_points_awarded, session_date, session_timing, client_request_id)
  values (reciter.id, p_listener_type, case when p_listener_type = 'student' then listener.id end,
    p_pages, nullif(trim(p_surah_range), ''), p_method, p_satisfaction, nullif(trim(p_notes), ''),
    reciter_points, listener_points, effective_day, p_session_timing, p_client_request_id)
  returning id into inserted_id;

  return jsonb_build_object('id', inserted_id, 'pointsAwarded', reciter_points,
    'listenerPointsAwarded', listener_points, 'sessionDate', effective_day, 'duplicate', false);
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
    'listenerPointsAwarded', existing.listener_points_awarded, 'sessionDate', existing.session_date, 'duplicate', true);
end;
$$;

grant execute on function public.record_student_session(text,uuid,text,text,numeric,text,text,text,text,text,date)
  to anon, authenticated;

commit;
