-- Taahud: keep student browser sessions cached for 30 days.
-- Run once in Supabase SQL Editor after deploying the matching app.js change.

create or replace function public.student_login(auth_code text, auth_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  matched public.students%rowtype;
  raw_token text;
begin
  delete from public.student_auth_sessions where expires_at <= now();

  select * into matched
  from public.students s
  where s.active
    and public.taahud_normalize_student_code(s.code) = public.taahud_normalize_student_code(auth_code)
    and s.password_hash = extensions.crypt(auth_password, s.password_hash)
  limit 1;

  if matched.id is null then
    raise exception 'invalid_login' using errcode = 'P0001';
  end if;

  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.student_auth_sessions (token_hash, student_id, expires_at)
  values (encode(extensions.digest(raw_token, 'sha256'), 'hex'), matched.id, now() + interval '30 days');

  return jsonb_build_object(
    'accessToken', raw_token,
    'expiresAt', now() + interval '30 days',
    'student', jsonb_build_object('id', matched.id, 'code', matched.code, 'name', matched.name),
    'mustChangePassword', matched.password_changed_at is null
  );
end;
$$;

update public.student_auth_sessions
set expires_at = greatest(expires_at, now() + interval '30 days')
where expires_at > now();

grant execute on function public.student_login(text,text) to anon, authenticated;
