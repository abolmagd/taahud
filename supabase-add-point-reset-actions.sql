-- Taahud: add audited admin actions for resetting student points.
-- Run this once in the SQL Editor of the same Supabase project used by the site.

begin;

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

revoke execute on function public.admin_reset_student_points(uuid,text) from public, anon;
revoke execute on function public.admin_reset_all_points(text) from public, anon;
grant execute on function public.admin_reset_student_points(uuid,text) to authenticated;
grant execute on function public.admin_reset_all_points(text) to authenticated;

commit;
