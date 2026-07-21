# تعاهُد (Ta'ahud) — Quran Recitation Tracker

Replaces the "التسجيل الدوري - برنامج تعاهُد" Google Form with a small two-page
app: a public student check-in form and a password-gated admin dashboard.

Fully independent from the SIRIUS MCQ project — its own repo, its own Supabase
project, its own Vercel deployment.

## One-time setup

1. Create a new project at https://supabase.com/dashboard (e.g. named "taahud").
2. In the new project's SQL Editor, run `supabase-schema.sql`, then
   `supabase-upgrade-2026-07.sql` in that order. Existing projects only need
   the upgrade file.
   If the random-password upgrade was previously deployed, run
   `supabase-fix-default-password-reset.sql` once to restore `123456789` for
   student add/reset actions.
   Run `supabase-fix-code-leading-zeros.sql` once to make numeric login codes
   ignore Arabic/English digit shape and leading zeroes.
   Run `supabase-add-point-reset-actions.sql` once to enable the admin actions
   for resetting one student's points or all students' points.
   Run `supabase-recalculate-historical-points.sql` once to make point-rule
   changes recalculate all existing sessions.
   Run `supabase-reset-all-student-passwords.sql` once to immediately reset
   every student password to `123456789` and enable the matching admin action.
   Run `supabase-fix-session-recording-visibility.sql` once if a submitted
   student session shows success but does not appear in student/admin records.
   Run `supabase-extend-student-session-cache.sql` once to keep student logins
   saved in the browser for 30 days.
3. In Authentication → Users, add one user: email `admin@taahud.local`, password
   of your choice. This is the only login in the whole app — it's the admin
   account. Database policies verify this exact email before granting admin access.
4. In Project Settings → API, copy the Project URL and the `anon` public key
   into `supabase-config.js` (`SUPABASE_URL` / `SUPABASE_ANON_KEY`).
5. In the admin dashboard (`admin.html`), log in and use the "الطلاب" tab to
   add students individually or import a two-column CSV (`code,name`). New and
   reset accounts use `123456789` until the student changes it on first login.
6. In the "الإعدادات" tab, set the three point rules: daily check-in/streak,
   points per recited page, and points per listened page.

## Local development

No build step. Serve the folder with any static file server, e.g.:

```bash
npx serve .
```

Then open `index.html` (student check-in) or `admin.html` (admin dashboard).

## Tests

Pure business logic (points calculation, stats aggregation, session-log
filtering) has unit tests:

```bash
npm test
```

With a local server running on port 4173 and Playwright available, the reusable
desktop/mobile browser audit can be run with:

```bash
NODE_PATH=/path/to/node_modules node tests/browser-audit.cjs
```

## Deploying

Deploy the project root to Vercel as a static site (no build command needed).
`vercel.json` sets a few basic security headers.

## End-to-end QA checklist (run once after setup, and after any deploy)

- [ ] Student login accepts `123456789`, forces an 8-character
      replacement, and restores the saved browser session after a refresh.
- [ ] Student check-in loads active listener codes without exposing names or
      password status to anonymous visitors.
- [ ] Submitting a session with a real student listener creates a `sessions`
      row with the correct `points_awarded` for the reciter and
      `listener_points_awarded` for the listener.
- [ ] Submitting with "وِرد استماع" or "شخص آخر خارج تعاهُد" creates listener
      points of `0`, while the reciter still gets their configured daily/page
      points.
- [ ] Admin login rejects a wrong password and accepts the right one.
- [ ] Admin can add/deactivate a student, reset the password to `123456789`, and
      a deactivated student disappears from the check-in dropdowns.
- [ ] Admin can reset every student password to `123456789`; existing student
      sessions end and the forced password-change screen appears next login.
- [ ] Admin can reset one student's points or all points without deleting any
      session, and each action appears in `admin_audit_log` with its reason.
- [ ] Changing point rules recalculates all existing non-deleted sessions and
      preserves the daily streak requirement for each student.
- [ ] Admin stats table shows correct totals for day/week/month and sorts on
      column click.
- [ ] Admin records list filters by text/student/type/method/date, exports CSV,
      and edit/delete actions appear in `admin_audit_log`.
