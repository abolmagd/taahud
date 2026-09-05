-- Ta'ahud: store the optional Quran recitation end point ("إلى").
-- Run once in the Supabase SQL Editor after supabase-add-reading-session-kind.sql.

begin;

alter table public.sessions
  add column if not exists surah_to text;

create or replace function public.get_student_profile(access_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sid uuid := public.taahud_student_id_for_token(access_token);
  current_student public.students%rowtype;
  sessions_json jsonb;
begin
  if sid is null then
    raise exception 'invalid_student_session' using errcode = 'P0001';
  end if;

  select * into current_student from public.students where id = sid;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'createdAt', s.created_at,
    'sessionDate', s.session_date,
    'sessionTiming', s.session_timing,
    'sessionKind', coalesce(s.session_kind, 'recitation'),
    'matnName', s.matn_name,
    'role', case when s.student_id = sid then 'reciter' else 'listener' end,
    'counterpart', case
      when s.student_id = sid and s.listener_type = 'outside' then 'شخص آخر خارج تعاهُد'
      when s.student_id = sid and s.listener_type = 'listening_only' then 'وِرد استماع'
      when s.student_id = sid and listener.id is not null then listener.code || ' - ' || listener.name
      when reciter.id is not null then reciter.code || ' - ' || reciter.name
      else ''
    end,
    'pages', s.pages,
    'surahRange', s.surah_range,
    'surahTo', s.surah_to,
    'method', s.method,
    'satisfaction', s.satisfaction,
    'notes', s.notes,
    'points', case when s.student_id = sid then s.points_awarded else s.listener_points_awarded end
  ) order by s.session_date desc, s.created_at desc), '[]'::jsonb)
  into sessions_json
  from public.sessions s
  left join public.students reciter on reciter.id = s.student_id
  left join public.students listener on listener.id = s.listener_student_id
  where s.deleted_at is null
    and (s.student_id = sid or (s.listener_type = 'student' and s.listener_student_id = sid));

  return jsonb_build_object(
    'student', jsonb_build_object('id', current_student.id, 'code', current_student.code, 'name', current_student.name),
    'mustChangePassword', current_student.password_changed_at is null,
    'sessions', sessions_json
  );
end;
$$;

-- This overload preserves the existing session-recording logic and adds the new value.
create function public.record_student_session(
  access_token text,
  p_client_request_id uuid,
  p_listener_type text,
  p_listener_code text,
  p_pages numeric,
  p_surah_range text,
  p_surah_to text,
  p_method text,
  p_satisfaction text,
  p_notes text,
  p_session_timing text,
  p_session_date date,
  p_session_kind text,
  p_matn_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  saved jsonb;
begin
  saved := public.record_student_session(
    access_token, p_client_request_id, p_listener_type, p_listener_code, p_pages,
    p_surah_range, p_method, p_satisfaction, p_notes, p_session_timing,
    p_session_date, p_session_kind, p_matn_name
  );

  if not coalesce((saved->>'duplicate')::boolean, false) then
    update public.sessions
    set surah_to = case
      when coalesce(session_kind, 'recitation') = 'recitation' then nullif(trim(p_surah_to), '')
      else null
    end
    where id = (saved->>'id')::uuid;
  end if;

  return saved;
end;
$$;

grant execute on function public.record_student_session(text,uuid,text,text,numeric,text,text,text,text,text,text,date,text,text)
  to anon, authenticated;

-- This overload keeps the existing audit and validation behavior while allowing
-- the admin to edit the new end-point field.
create function public.admin_update_session(
  target_session_id uuid,
  p_pages numeric,
  p_surah_range text,
  p_surah_to text,
  p_matn_name text,
  p_method text,
  p_satisfaction text,
  p_notes text,
  p_session_date date,
  p_points_awarded integer,
  p_listener_points_awarded integer,
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

revoke execute on function public.admin_update_session(uuid,numeric,text,text,text,text,text,text,date,integer,integer,text)
  from public, anon;
grant execute on function public.admin_update_session(uuid,numeric,text,text,text,text,text,text,date,integer,integer,text)
  to authenticated;

commit;
