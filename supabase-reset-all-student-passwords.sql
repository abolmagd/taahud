-- Taahud: immediately reset every student password to 123456789.
-- This also installs the admin action for repeating the reset later.
-- Run once in the SQL Editor of the same Supabase project used by the site.

begin;

create extension if not exists pgcrypto with schema extensions;

create or replace function public.reset_all_student_passwords(change_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  reset_students bigint := 0;
begin
  if not public.taahud_is_admin() then raise exception 'admin_required' using errcode = 'P0001'; end if;
  if trim(coalesce(change_reason,'')) = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;

  lock table public.students in share row exclusive mode;

  update public.students
  set password_hash = extensions.crypt('123456789', extensions.gen_salt('bf')),
      password_changed_at = null;
  get diagnostics reset_students = row_count;

  delete from public.student_auth_sessions;

  insert into public.admin_audit_log(admin_id,action,entity_type,new_data,reason)
  values(
    auth.uid(),'reset_all_passwords','student',
    jsonb_build_object('resetStudents',reset_students,'temporaryPassword','123456789'),
    trim(change_reason)
  );

  return jsonb_build_object('resetStudents',reset_students,'temporaryPassword','123456789');
end;
$$;

revoke execute on function public.reset_all_student_passwords(text) from public, anon;
grant execute on function public.reset_all_student_passwords(text) to authenticated;

-- Apply the requested one-time reset immediately when this migration runs.
do $$
declare
  reset_students bigint := 0;
begin
  lock table public.students in share row exclusive mode;

  update public.students
  set password_hash = extensions.crypt('123456789', extensions.gen_salt('bf')),
      password_changed_at = null;
  get diagnostics reset_students = row_count;

  delete from public.student_auth_sessions;

  insert into public.admin_audit_log(action,entity_type,new_data,reason)
  values(
    'reset_all_passwords','student',
    jsonb_build_object('resetStudents',reset_students,'temporaryPassword','123456789'),
    'One-time reset requested by the administrator'
  );
end;
$$;

commit;
