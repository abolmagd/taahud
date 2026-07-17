-- Taahud: restore the requested shared default password for add/reset actions.
-- Run this once in the SQL Editor of the same Supabase project used by the site.

begin;

create extension if not exists pgcrypto with schema extensions;

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

create or replace function public.taahud_generate_temporary_password()
returns text
language sql
immutable
security definer
set search_path = public, extensions
as $$
  select '123456789'::text;
$$;

create or replace function public.reset_student_password(target_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  changed public.students%rowtype;
begin
  if not public.taahud_is_admin() then
    raise exception 'admin_required' using errcode = 'P0001';
  end if;

  update public.students
  set password_hash = extensions.crypt('123456789', extensions.gen_salt('bf')),
      password_changed_at = null
  where id = target_student_id
  returning * into changed;

  if changed.id is null then
    raise exception 'student_not_found' using errcode = 'P0001';
  end if;

  delete from public.student_auth_sessions where student_id = changed.id;

  insert into public.admin_audit_log(admin_id, action, entity_type, entity_id)
  values(auth.uid(), 'reset_password', 'student', changed.id);

  return jsonb_build_object(
    'id', changed.id,
    'code', changed.code,
    'name', changed.name,
    'temporaryPassword', '123456789'
  );
end;
$$;

revoke execute on function public.taahud_generate_temporary_password() from public, anon, authenticated;
revoke execute on function public.taahud_is_admin() from public, anon, authenticated;
revoke execute on function public.reset_student_password(uuid) from public, anon;
grant execute on function public.taahud_is_admin() to authenticated;
grant execute on function public.reset_student_password(uuid) to authenticated;

commit;
