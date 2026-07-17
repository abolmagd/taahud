-- Taahud: make numeric student codes ignore leading zeroes and digit script.
-- Examples treated as the same code: 1, 01, 001, ٠١, and ۰۱.

begin;

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
  if not public.taahud_is_admin() then
    raise exception 'admin_required' using errcode = 'P0001';
  end if;
  if trim(coalesce(p_code, '')) = '' or trim(coalesce(p_name, '')) = '' then
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
  values(auth.uid(), 'create', 'student', created.id, jsonb_build_object('code', created.code, 'name', created.name));

  return jsonb_build_object(
    'id', created.id,
    'code', created.code,
    'name', created.name,
    'temporaryPassword', temp_password
  );
end;
$$;

revoke execute on function public.taahud_normalize_student_code(text) from public, anon, authenticated;
revoke execute on function public.create_student_with_temp_password(text, text) from public, anon;
grant execute on function public.create_student_with_temp_password(text, text) to authenticated;

commit;
