# تعاهُد (Ta'ahud) — Quran Recitation Tracker: Design

Date: 2026-07-08
Status: Approved by user, pending final spec review

## 1. Purpose

Replace the current Google Form ("التسجيل الدوري - برنامج تعاهُد") used to log Quran
recitation/listening sessions between students, with a small dedicated web app that:

- Lets a student log a session in a few taps (student-facing form).
- Automatically awards points to whichever student acted as *listener* (سامع) the
  moment a session naming them is submitted.
- Gives the admin a dashboard with per-student stats (pages recited, pages
  listened-to, points, sessions) broken down daily / weekly / monthly.

This is a **new, fully independent project** — separate git repo, separate Supabase
project, separate Vercel deployment. It does not touch the SIRIUS MCQ codebase
(`/Users/mac/Documents/MCQ v1/deployment/`) or its Supabase project. The only thing it
borrows from SIRIUS is visual style (colors, type, card/radius language) so it feels
like part of the same family of tools.

Source of truth for the original form fields: reverse-engineered from the live
Google Form's `FB_PUBLIC_LOAD_DATA_` payload (fetched during design), not just the
form's visible intro text.

## 2. Non-goals

- No student login/password — identity is just picking your code from a dropdown,
  same as the original Google Form.
- No fraud prevention (self-listening, duplicate submissions) — explicitly allowed
  per user decision; admin will police manually if ever needed.
- No integration with the SIRIUS MCQ app, its Supabase project, or its student
  accounts.
- No mobile app — responsive web only.

## 3. Architecture

- Plain HTML/CSS/JS (no framework, no build step) — mirrors the SIRIUS MCQ stack's
  simplicity.
- Supabase JS client loaded via CDN, talking to a **new** Supabase project created
  for this app.
- Two pages:
  - `index.html` — public student check-in form.
  - `admin.html` — password-gated admin dashboard.
- Deployed as a static site on Vercel (same pattern as SIRIUS's `deployment/`).

### Why real auth for a "simple password" admin login

The admin login is presented as a single password field, but under the hood it uses
Supabase Auth with one fixed admin account (email hidden/pre-filled, only a password
field shown). This matters because Postgres Row Level Security policies need a real
authenticated session to distinguish "admin" from "anonymous student" — a purely
client-side password check would still leave all data readable/writable directly via
the Supabase anon API regardless of what the UI shows. This mirrors the `is_admin()`
RLS pattern already used in the SIRIUS schema.

## 4. Data model (new Supabase project)

```sql
create table students (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,       -- e.g. "001".."081", admin-managed, not
                                          -- required to be zero-padded or numeric
  name       text not null,
  active     boolean not null default true,  -- soft-delete flag
  created_at timestamptz default now()
);

create table sessions (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references students(id),  -- the reciter (submitter)
  listener_type       text not null check (listener_type in ('student','outside','listening_only')),
  listener_student_id uuid references students(id),  -- set only when listener_type = 'student'
  pages               numeric not null,
  surah_range         text,              -- optional free text, e.g. "النساء ٣٣ - ٥٩"
  method              text not null,     -- one of the 7 method options (see §5)
  satisfaction        text not null,     -- one of the 4 satisfaction options (see §5)
  notes               text,              -- optional
  points_awarded      integer not null default 0,  -- snapshot of settings.point_value
                                                     -- at submission time; only > 0
                                                     -- when listener_type = 'student'
  created_at          timestamptz default now()
);

create table settings (
  key   text primary key,
  value jsonb not null
);
-- seeded row: ('point_value', '{"value": <admin-editable integer>}')
```

Points are snapshotted onto the session row rather than computed live from the
current `point_value`, so changing the point value later does not retroactively
change historical totals. A student's total points = `sum(points_awarded)` over all
sessions where they are `listener_student_id`.

RLS:
- `students`: public **select** (needed to populate the two dropdowns); insert/
  update/delete restricted to the authenticated admin.
- `sessions`: public **insert** (student check-in, no login); select/update/delete
  restricted to the authenticated admin (so raw stats aren't publicly scrapeable).
- `settings`: public **select**, admin-only insert/update/delete. The point value
  itself isn't sensitive (it's not student data), so the check-in form can read it
  directly at submission time with a plain `select`.

## 5. Student check-in form (`index.html`)

Mirrors the original Google Form's fields, with the free-text "pages + range"
field split into two clean inputs for computability:

1. **الكود الخاص بك** — required dropdown, populated from `students` (code — name).
2. **كود الحافظ الذي سمعت عليه** — required dropdown: all student codes, plus two
   special fixed options: "شخص آخر خارج تعاهُد" and "وِرد استماع" (kept verbatim from
   the original form — the latter covers "I was just listening, not reciting to
   anyone").
3. **عدد الصفحات** — required number input.
4. **من (اختياري)** — optional free text for the surah/ayah range (e.g. "النساء ٣٣ - ٥٩").
5. **طريقة التسميع؟** — required dropdown: تليجرام / واتس / مكالمة هاتفية / جوجل ميت /
   مقابلة / استماع / أخرى (verbatim from original form, 7 options).
6. **هل أنت راض عن جودة محفوظك الذي سمعته؟** — required dropdown: نعم تماما / يحتاج
   إلى مزيد من الضبط / وردي كان ورد استماع / (blank option, verbatim from original).
7. **ملاحظات واقتراحات** — optional textarea.

On submit: insert one `sessions` row. If `listener_type = 'student'`, set
`points_awarded` to the current `point_value` from `settings` and
`listener_student_id` to the chosen student — this is the "automatic point award"
requirement, applied at insert time with no separate admin action needed. Show a
simple success confirmation (matching SIRIUS's toast/confirmation style) and reset
the form for the next entry.

Self-selecting yourself as listener, and submitting duplicate sessions, are both
allowed with no special handling (explicit user decision).

## 6. Admin panel (`admin.html`)

- **Login**: single password field (Supabase Auth under the hood, see §3).
- **Student roster tab**: table of students (code, name, active toggle), with
  add / edit / remove actions. Removing a student is a soft-delete (`active =
  false`) so historical sessions referencing them stay intact.
- **Settings**: editable `point_value` (integer, admin-editable at any time; only
  affects future submissions, per §4).
- **Stats dashboard**: per-student rows showing, for a selectable period
  (day / week / month — simple toggle or tab):
  - Pages recited (as reciter) and number of recitation sessions.
  - Pages listened-to (as listener) and number of listening sessions.
  - Points earned in the period.
  Sortable by any column so the admin can quickly see e.g. "who hasn't recited
  this week" or "who has the most points." "Week" boundaries are Saturday–Friday
  (the common convention in Egypt), "month" is calendar month.
- **Session log**: flat, filterable table of all raw submissions (reciter, listener,
  pages, range, method, satisfaction, notes, timestamp) for spot-checking/auditing.

## 7. Visual style

Reuses SIRIUS's existing design tokens (copied as static values into this project's
own stylesheet — not a shared/imported file, since the projects are independent):

```css
--bg: #050504;
--surface: #0d0b09;
--surface-soft: #15120e;
--surface-strong: #211c15;
--text: #faf6ea;
--muted: #b8ad9a;
--line: #373023;
--accent: #d2aa5c;
--accent-strong: #f2d390;
--success: #1c7256;
--danger: #a73434;
--warning: #9b650e;
--radius-lg: 18px;
--radius-md: 12px;
--radius-sm: 9px;
--font-sans: "Figtree", "Noto Sans", ui-sans-serif, system-ui, -apple-system,
  BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Same glass-card surfaces, gold accent, dark theme by default. Branded as "تعاهُد"
(own name/heading), not SIRIUS.

