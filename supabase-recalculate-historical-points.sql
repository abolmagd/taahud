-- Taahud: make point-rule changes recalculate every existing active session.
-- Run this once in the SQL Editor of the same Supabase project used by the site.

begin;

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
  old_total_points bigint := 0;
  new_total_points bigint := 0;
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
  select coalesce(sum(s.points_awarded::bigint + s.listener_points_awarded::bigint), 0)
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
  set points_awarded = trunc(s.pages * p_reciter_page)::integer +
        case when exists (
          select 1 from daily_awards a where a.session_id = s.id and a.student_id = s.student_id
        ) then p_daily_checkin else 0 end,
      listener_points_awarded = case
        when s.listener_type = 'student' and s.listener_student_id is not null then
          trunc(s.pages * p_listener_page)::integer +
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

  select coalesce(sum(s.points_awarded::bigint + s.listener_points_awarded::bigint), 0)
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

commit;
