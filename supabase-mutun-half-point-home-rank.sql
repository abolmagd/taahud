-- Taahud: half a point per memorized verse, plus private student score rank.
-- Run once after supabase-add-surah-to.sql. Existing mutun sessions are adjusted below.

begin;

alter table public.sessions
  alter column points_awarded type numeric,
  alter column listener_points_awarded type numeric;

-- Preserve existing daily awards and any deliberate point resets while replacing
-- the old mutun page component. Reading and Quran sessions keep their rules.
with current_rule as (
  select coalesce((value->>'reciterPage')::integer, 2) as reciter_page
  from public.settings where key = 'point_rules'
)
update public.sessions s
set points_awarded = case
  when s.points_awarded = 0 then 0
  else greatest(0, s.points_awarded - trunc(s.pages * coalesce((select reciter_page from current_rule), 2))) + s.pages * 0.5
end
where s.session_kind = 'mutun' and s.deleted_at is null
  and not exists (select 1 from public.settings where key = 'mutun_half_point_migrated');

insert into public.settings(key, value)
values ('mutun_half_point_migrated', '{"applied": true}'::jsonb)
on conflict (key) do nothing;

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
  reciter_points numeric;
  listener_points numeric := 0;
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
  if session_kind in ('mutun', 'reading') and trim(coalesce(p_matn_name, '')) = '' then
    if session_kind = 'mutun' then
      raise exception 'missing_matn_name' using errcode = 'P0001';
    end if;
    raise exception 'missing_book_name' using errcode = 'P0001';
  end if;
  if p_listener_type not in ('student', 'outside', 'listening_only') then
    raise exception 'invalid_listener_type' using errcode = 'P0001';
  end if;
  if session_kind in ('mutun', 'reading') and p_listener_type <> 'outside' then
    raise exception 'invalid_listener_type' using errcode = 'P0001';
  end if;
  if p_pages is null or p_pages <= 0 then
    raise exception 'invalid_pages' using errcode = 'P0001';
  end if;
  if session_kind = 'mutun' and p_pages <> trunc(p_pages) then
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
    + case when session_kind = 'mutun' then p_pages * 0.5 else trunc(p_pages * reciter_page_points) end;
  if p_listener_type = 'student' then
    listener_points := (case when award_listener_daily then daily_points else 0 end)
      + trunc(p_pages * listener_page_points)::integer;
  end if;

  insert into public.sessions (student_id, listener_type, listener_student_id, pages, surah_range,
    session_kind, matn_name, method, satisfaction, notes, points_awarded, listener_points_awarded,
    session_date, session_timing, client_request_id)
  values (reciter.id, p_listener_type, case when p_listener_type = 'student' then listener.id end,
    p_pages, case when session_kind = 'recitation' then nullif(trim(p_surah_range), '') end,
    session_kind, case when session_kind in ('mutun', 'reading') then nullif(trim(p_matn_name), '') end,
    p_method, p_satisfaction, nullif(trim(p_notes), ''),
    reciter_points, listener_points, effective_day, p_session_timing, p_client_request_id)
  returning id into inserted_id;

  return jsonb_build_object('id', inserted_id, 'pointsAwarded', reciter_points,
    'listenerPointsAwarded', listener_points, 'sessionDate', effective_day,
    'sessionKind', session_kind, 'matnName', case when session_kind in ('mutun', 'reading') then nullif(trim(p_matn_name), '') end,
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

grant execute on function public.record_student_session(text,uuid,text,text,numeric,text,text,text,text,text,date,text,text) to anon, authenticated;

-- Replace the admin edit signatures so fractional point values can be saved.
drop function if exists public.admin_update_session(uuid,numeric,text,text,text,text,text,text,date,integer,integer,text);
drop function if exists public.admin_update_session(uuid,numeric,text,text,text,text,text,date,integer,integer,text);

create or replace function public.admin_update_session(
  target_session_id uuid,
  p_pages numeric,
  p_surah_range text,
  p_matn_name text,
  p_method text,
  p_satisfaction text,
  p_notes text,
  p_session_date date,
  p_points_awarded numeric,
  p_listener_points_awarded numeric,
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

  if p_pages <= 0 or (row_kind = 'mutun' and p_pages <> trunc(p_pages))
    or p_session_date > public.taahud_current_local_date()
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
  if row_kind in ('mutun', 'reading') and trim(coalesce(p_matn_name, '')) = '' then
    raise exception 'invalid_session_values' using errcode = 'P0001';
  end if;
  update public.sessions
  set pages = p_pages,
      surah_range = case when row_kind = 'recitation' then nullif(trim(p_surah_range), '') else old_row.surah_range end,
      matn_name = case when row_kind in ('mutun', 'reading') then nullif(trim(p_matn_name), '') else old_row.matn_name end,
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
    jsonb_build_object('pages',p_pages,'matnName',case when row_kind in ('mutun', 'reading') then nullif(trim(p_matn_name), '') else old_row.matn_name end,
      'method',p_method,'satisfaction',p_satisfaction,'sessionDate',p_session_date,
      'pointsAwarded',p_points_awarded,'listenerPointsAwarded',p_listener_points_awarded),nullif(trim(change_reason),''));
end;
$$;

revoke execute on function public.admin_update_session(uuid,numeric,text,text,text,text,text,date,numeric,numeric,text) from public, anon;
grant execute on function public.admin_update_session(uuid,numeric,text,text,text,text,text,date,numeric,numeric,text) to authenticated;

create or replace function public.admin_update_session(
  target_session_id uuid,
  p_pages numeric,
  p_surah_range text,
  p_surah_to text,
  p_matn_name text,
  p_method text,
  p_satisfaction text,
  p_notes text,
  p_session_date date,
  p_points_awarded numeric,
  p_listener_points_awarded numeric,
  change_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_update_session(
    target_session_id, p_pages, p_surah_range, p_matn_name, p_method,
    p_satisfaction, p_notes, p_session_date, p_points_awarded,
    p_listener_points_awarded, change_reason
  );

  update public.sessions
  set surah_to = case
    when coalesce(session_kind, 'recitation') = 'recitation' then nullif(trim(p_surah_to), '')
    else null
  end
  where id = target_session_id;
end;
$$;

revoke execute on function public.admin_update_session(uuid,numeric,text,text,text,text,text,text,date,numeric,numeric,text) from public, anon;
grant execute on function public.admin_update_session(uuid,numeric,text,text,text,text,text,text,date,numeric,numeric,text) to authenticated;

create or replace function public.admin_reset_student_points(target_student_id uuid, change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_student public.students%rowtype;
  removed_points numeric := 0;
  affected_sessions bigint := 0;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if trim(coalesce(change_reason,'')) = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;

  select * into target_student from public.students where id = target_student_id;
  if target_student.id is null then raise exception 'student_not_found' using errcode = 'P0001'; end if;

  lock table public.sessions in share row exclusive mode;

  select
    coalesce(sum(
      case when s.student_id = target_student_id then s.points_awarded else 0 end +
      case when s.listener_type = 'student' and s.listener_student_id = target_student_id
        then s.listener_points_awarded else 0 end
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
  removed_points numeric := 0;
  affected_sessions bigint := 0;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if trim(coalesce(change_reason,'')) = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;

  lock table public.sessions in share row exclusive mode;

  select
    coalesce(sum(s.points_awarded + s.listener_points_awarded), 0),
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

create or replace function public.admin_update_point_rules(
  p_daily_checkin integer,
  p_reciter_page integer,
  p_listener_page integer,
  change_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  old_rules jsonb;
  old_total_points numeric := 0;
  new_total_points numeric := 0;
  updated_sessions bigint := 0;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if trim(coalesce(change_reason,'')) = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;
  if p_daily_checkin is null or p_reciter_page is null or p_listener_page is null
    or p_daily_checkin < 0 or p_reciter_page < 0 or p_listener_page < 0
    or p_daily_checkin > 100000 or p_reciter_page > 100000 or p_listener_page > 100000 then
    raise exception 'invalid_point_rules' using errcode = 'P0001';
  end if;

  lock table public.settings in access exclusive mode;
  lock table public.sessions in share row exclusive mode;

  select value into old_rules from public.settings where key = 'point_rules';
  select coalesce(sum(s.points_awarded + s.listener_points_awarded), 0)
  into old_total_points
  from public.sessions s
  where s.deleted_at is null;

  insert into public.settings(key,value)
  values(
    'point_rules',
    jsonb_build_object(
      'dailyCheckin',p_daily_checkin,
      'reciterPage',p_reciter_page,
      'listenerPage',p_listener_page
    )
  )
  on conflict (key) do update set value = excluded.value;

  with participations as (
    select s.id as session_id, s.student_id, s.session_date, s.created_at, 0 as role_order
    from public.sessions s
    where s.deleted_at is null
    union all
    select s.id, s.listener_student_id, s.session_date, s.created_at, 1
    from public.sessions s
    where s.deleted_at is null
      and s.listener_type = 'student'
      and s.listener_student_id is not null
  ),
  participation_days as (
    select distinct p.student_id, p.session_date
    from participations p
  ),
  sequenced_days as (
    select d.student_id, d.session_date,
      lag(d.session_date) over (partition by d.student_id order by d.session_date) as previous_day
    from participation_days d
  ),
  eligible_days as (
    select d.student_id, d.session_date
    from sequenced_days d
    where d.previous_day is null or d.previous_day = d.session_date - 1
  ),
  ranked_participations as (
    select p.*,
      row_number() over (
        partition by p.student_id, p.session_date
        order by p.created_at nulls last, p.session_id, p.role_order
      ) as day_position
    from participations p
  ),
  daily_awards as (
    select p.session_id, p.student_id
    from ranked_participations p
    join eligible_days d on d.student_id = p.student_id and d.session_date = p.session_date
    where p.day_position = 1
  )
  update public.sessions s
  set points_awarded = (case when s.session_kind = 'mutun' then s.pages * 0.5 else trunc(s.pages * p_reciter_page) end) +
        case when exists (
          select 1 from daily_awards a where a.session_id = s.id and a.student_id = s.student_id
        ) then p_daily_checkin else 0 end,
      listener_points_awarded = case
        when s.listener_type = 'student' and s.listener_student_id is not null then
          trunc(s.pages * p_listener_page) +
          case when exists (
            select 1 from daily_awards a
            where a.session_id = s.id and a.student_id = s.listener_student_id
          ) then p_daily_checkin else 0 end
        else 0
      end,
      updated_at = now(),
      updated_by = auth.uid()
  where s.deleted_at is null;

  get diagnostics updated_sessions = row_count;

  select coalesce(sum(s.points_awarded + s.listener_points_awarded), 0)
  into new_total_points
  from public.sessions s
  where s.deleted_at is null;

  insert into public.admin_audit_log(admin_id,action,entity_type,old_data,new_data,reason)
  values(
    auth.uid(),'update_point_rules','settings',
    jsonb_build_object('rules',coalesce(old_rules,'{}'::jsonb),'totalPoints',old_total_points),
    jsonb_build_object(
      'rules',jsonb_build_object(
        'dailyCheckin',p_daily_checkin,
        'reciterPage',p_reciter_page,
        'listenerPage',p_listener_page
      ),
      'totalPoints',new_total_points,
      'updatedSessions',updated_sessions
    ),
    trim(change_reason)
  );

  return jsonb_build_object(
    'updatedSessions',updated_sessions,
    'oldTotalPoints',old_total_points,
    'newTotalPoints',new_total_points
  );
end;
$$;

revoke execute on function public.admin_update_point_rules(integer,integer,integer,text) from public, anon;
grant execute on function public.admin_update_point_rules(integer,integer,integer,text) to authenticated;

create or replace function public.get_student_score_rank(access_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sid uuid := public.taahud_student_id_for_token(access_token);
  result jsonb;
begin
  if sid is null then
    raise exception 'invalid_student_session' using errcode = 'P0001';
  end if;

  with scores as (
    select st.id,
      coalesce(sum(case when se.student_id = st.id then se.points_awarded else 0 end), 0) +
      coalesce(sum(case when se.listener_type = 'student' and se.listener_student_id = st.id
        then se.listener_points_awarded else 0 end), 0) as points
    from public.students st
    left join public.sessions se on se.deleted_at is null
      and (se.student_id = st.id or
        (se.listener_type = 'student' and se.listener_student_id = st.id))
    where st.active
    group by st.id
  ), standings as (
    select id, points, rank() over (order by points desc) as position,
      count(*) over () as student_count
    from scores
  )
  select jsonb_build_object('rank', position, 'totalStudents', student_count, 'points', points)
  into result
  from standings where id = sid;
  return result;
end;
$$;

revoke execute on function public.get_student_score_rank(text) from public, anon;
grant execute on function public.get_student_score_rank(text) to anon, authenticated;

commit;
