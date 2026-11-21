-- Manual awards are independent of sessions and of session point rules.
begin;

create table if not exists public.student_point_awards (
  id uuid primary key,
  student_id uuid not null references public.students(id) on delete cascade,
  points numeric not null check (points > 0 and points <= 1000000000 and mod(points, 0.5) = 0),
  awarded_on date not null default public.taahud_current_local_date(),
  voided_at timestamptz
);

create index if not exists student_point_awards_active_idx
  on public.student_point_awards (student_id, awarded_on) where voided_at is null;

alter table public.student_point_awards enable row level security;
drop policy if exists admin_read_student_point_awards on public.student_point_awards;
create policy admin_read_student_point_awards on public.student_point_awards
  for select to authenticated using (public.taahud_is_admin());
revoke all on public.student_point_awards from public, anon, authenticated;
grant select on public.student_point_awards to authenticated;

create or replace function public.admin_award_student_points(
  target_student_id uuid, award_points numeric, change_reason text, request_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  award public.student_point_awards%rowtype;
  reason_text text := regexp_replace(coalesce(change_reason, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
begin
  if public.taahud_is_admin() is not true then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if award_points is null or award_points <= 0 or award_points > 1000000000 or mod(award_points, 0.5) <> 0 then
    raise exception 'invalid_award_points' using errcode = 'P0001';
  end if;
  if reason_text = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;
  if char_length(reason_text) > 500 then raise exception 'reason_too_long' using errcode = 'P0001'; end if;
  if request_id is null then raise exception 'request_id_required' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.students where id = target_student_id) then
    raise exception 'student_not_found' using errcode = 'P0001';
  end if;

  insert into public.student_point_awards (id, student_id, points)
  values (request_id, target_student_id, award_points)
  on conflict (id) do nothing
  returning * into award;

  if found then
    insert into public.admin_audit_log (id, admin_id, action, entity_type, entity_id, new_data, reason)
    values (award.id, auth.uid(), 'award_points', 'student', award.student_id,
      jsonb_build_object('points', award.points, 'awardedOn', award.awarded_on), reason_text);
  else
    -- A retry can follow a successful write whose response never reached the admin.
    select a.* into award
    from public.student_point_awards a
    join public.admin_audit_log log on log.id = a.id
    where a.id = request_id and a.student_id = target_student_id and a.points = award_points
      and log.admin_id = auth.uid() and log.reason = reason_text;
    if not found then raise exception 'award_request_conflict' using errcode = 'P0001'; end if;
  end if;

  return jsonb_build_object('points', award.points, 'awardedOn', award.awarded_on);
end;
$$;
revoke all on function public.admin_award_student_points(uuid, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_award_student_points(uuid, numeric, text, uuid) to authenticated;

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
  removed_award_points numeric := 0;
begin
  if public.taahud_is_admin() is not true then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if trim(coalesce(change_reason,'')) = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;

  select * into target_student from public.students where id = target_student_id;
  if target_student.id is null then raise exception 'student_not_found' using errcode = 'P0001'; end if;

  lock table public.sessions in share row exclusive mode;
  lock table public.student_point_awards in share row exclusive mode;

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

  with voided as (
    update public.student_point_awards
    set voided_at = now()
    where student_id = target_student_id and voided_at is null
    returning points
  )
  select coalesce(sum(points), 0) into removed_award_points from voided;
  removed_points := removed_points + removed_award_points;

  insert into public.admin_audit_log(admin_id,action,entity_type,entity_id,old_data,new_data,reason)
  values(
    auth.uid(),'reset_points','student',target_student_id,
    jsonb_build_object('points',removed_points,'affectedSessions',affected_sessions,'awardPoints',removed_award_points),
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
  removed_award_points numeric := 0;
begin
  if public.taahud_is_admin() is not true then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if trim(coalesce(change_reason,'')) = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;

  lock table public.sessions in share row exclusive mode;
  lock table public.student_point_awards in share row exclusive mode;

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

  with voided as (
    update public.student_point_awards
    set voided_at = now()
    where voided_at is null
    returning points
  )
  select coalesce(sum(points), 0) into removed_award_points from voided;
  removed_points := removed_points + removed_award_points;

  insert into public.admin_audit_log(admin_id,action,entity_type,old_data,new_data,reason)
  values(
    auth.uid(),'reset_all_points','points',
    jsonb_build_object('points',removed_points,'affectedSessions',affected_sessions,'awardPoints',removed_award_points),
    jsonb_build_object('points',0),trim(change_reason)
  );

  return jsonb_build_object('removedPoints',removed_points,'affectedSessions',affected_sessions);
end;
$$;

revoke all on function public.admin_reset_student_points(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_reset_all_points(text) from public, anon, authenticated;
grant execute on function public.admin_reset_student_points(uuid, text) to authenticated;
grant execute on function public.admin_reset_all_points(text) to authenticated;

create or replace function public.get_student_score_rank(access_token text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  sid uuid := public.taahud_student_id_for_token(access_token);
  today date := public.taahud_current_local_date();
  week_start date := today - ((extract(dow from today)::integer + 1) % 7);
  month_start date := date_trunc('month', today)::date;
  month_end date := (month_start + interval '1 month')::date;
  result jsonb;
begin
  if sid is null then raise exception 'invalid_student_session' using errcode = 'P0001'; end if;

  with month_sessions as (
    select student_id, points_awarded, listener_type, listener_student_id, listener_points_awarded
    from public.sessions
    where deleted_at is null and session_date >= month_start and session_date < month_end
  ), monthly_points as (
    select student_id, points_awarded as points from month_sessions
    union all
    select listener_student_id, listener_points_awarded from month_sessions where listener_type = 'student'
    union all
    select student_id, points from public.student_point_awards
    where voided_at is null and awarded_on >= month_start and awarded_on < month_end
  ), scores as (
    select st.id, coalesce(sum(mp.points), 0) as points
    from public.students st left join monthly_points mp on mp.student_id = st.id
    where st.active group by st.id
  ), standings as (
    select id, points, rank() over (order by points desc) as position,
      count(*) over () as student_count, max(points) over () as leader_points
    from scores
  )
  select jsonb_build_object(
    'rank', position, 'totalStudents', student_count, 'points', points,
    'leaderPoints', leader_points,
    'previousPoints', (select min(s.points) from scores s where s.points > mine.points),
    'period', 'month', 'monthStart', month_start,
    'awardPoints', (
      select jsonb_build_object(
        'day', coalesce(sum(a.points) filter (where a.awarded_on = today), 0),
        'week', coalesce(sum(a.points) filter (where a.awarded_on >= week_start), 0),
        'all', coalesce(sum(a.points), 0)
      )
      from public.student_point_awards a where a.student_id = sid and a.voided_at is null
    )
  )
  into result from standings mine where id = sid;
  return result;
end;
$$;
revoke all on function public.get_student_score_rank(text) from public, anon, authenticated;
grant execute on function public.get_student_score_rank(text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
