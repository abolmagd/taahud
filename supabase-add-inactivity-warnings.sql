-- Current inactivity warnings and calendar-month student rankings.
-- One shared database calculation keeps student and admin views in sync.
begin;

create index if not exists sessions_recitation_activity_idx
  on public.sessions (student_id, session_date desc)
  where deleted_at is null and session_kind in ('recitation', 'mutun')
    and listener_type <> 'listening_only';

create or replace function public.taahud_inactivity_status()
returns table (
  student_id uuid, code text, name text, last_activity_date date,
  inactive_since date, inactive_days integer, warning_count integer,
  next_warning_date date, as_of_date date
)
language sql stable security definer set search_path = public
as $$
  with activity as (
    select se.student_id, se.session_date
    from public.sessions se
    where se.deleted_at is null and se.session_kind in ('recitation', 'mutun')
      and se.listener_type <> 'listening_only'
      and se.session_date <= public.taahud_current_local_date()
    union all
    select se.listener_student_id, se.session_date
    from public.sessions se
    where se.deleted_at is null and se.session_kind in ('recitation', 'mutun')
      and se.listener_type = 'student'
      and se.session_date <= public.taahud_current_local_date()
  ), latest as (
    select st.id, st.code, st.name, max(a.session_date) as last_activity,
      greatest((st.created_at at time zone 'Africa/Cairo')::date,
        coalesce(max(a.session_date), (st.created_at at time zone 'Africa/Cairo')::date)) as since
    from public.students st left join activity a on a.student_id = st.id
    where st.active group by st.id
  ), elapsed as (
    select *, greatest(0, public.taahud_current_local_date() - since) as days
    from latest
  )
  select id, code::text, name::text, last_activity, since, days, days / 7,
    since + ((days / 7 + 1) * 7), public.taahud_current_local_date()
  from elapsed;
$$;

revoke all on function public.taahud_inactivity_status() from public, anon, authenticated;

create or replace function public.get_student_warnings(access_token text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  sid uuid := public.taahud_student_id_for_token(access_token);
begin
  if sid is null then raise exception 'invalid_student_session' using errcode = 'P0001'; end if;
  return (
    select jsonb_build_object(
      'warningCount', warning_count, 'inactiveDays', inactive_days,
      'lastActivityDate', last_activity_date, 'inactiveSince', inactive_since,
      'nextWarningDate', next_warning_date, 'asOfDate', as_of_date
    ) from public.taahud_inactivity_status() where student_id = sid
  );
end;
$$;
revoke all on function public.get_student_warnings(text) from public, anon, authenticated;
grant execute on function public.get_student_warnings(text) to anon, authenticated;

create or replace function public.admin_get_student_warnings()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'studentId', student_id, 'code', code, 'name', name,
      'warningCount', warning_count, 'inactiveDays', inactive_days,
      'lastActivityDate', last_activity_date, 'inactiveSince', inactive_since,
      'nextWarningDate', next_warning_date, 'asOfDate', as_of_date
    ) order by warning_count desc, inactive_days desc, code), '[]'::jsonb)
    from public.taahud_inactivity_status()
  );
end;
$$;
revoke all on function public.admin_get_student_warnings() from public, anon, authenticated;
grant execute on function public.admin_get_student_warnings() to authenticated;

create or replace function public.get_student_score_rank(access_token text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  sid uuid := public.taahud_student_id_for_token(access_token);
  month_start date := date_trunc('month', public.taahud_current_local_date())::date;
  result jsonb;
begin
  if sid is null then raise exception 'invalid_student_session' using errcode = 'P0001'; end if;
  with scores as (
    select st.id,
      coalesce(sum(case when se.student_id = st.id then se.points_awarded else 0 end), 0) +
      coalesce(sum(case when se.listener_type = 'student' and se.listener_student_id = st.id
        then se.listener_points_awarded else 0 end), 0) as points
    from public.students st
    left join public.sessions se on se.deleted_at is null
      and se.session_date >= month_start
      and se.session_date < (month_start + interval '1 month')::date
      and (se.student_id = st.id or (se.listener_type = 'student' and se.listener_student_id = st.id))
    where st.active group by st.id
  ), standings as (
    select id, points, rank() over (order by points desc) as position,
      count(*) over () as student_count from scores
  )
  select jsonb_build_object('rank', position, 'totalStudents', student_count,
    'points', points, 'period', 'month', 'monthStart', month_start)
  into result from standings where id = sid;
  return result;
end;
$$;
revoke all on function public.get_student_score_rank(text) from public, anon, authenticated;
grant execute on function public.get_student_score_rank(text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
