# تعاهُد (Ta'ahud) — Quran Recitation Tracker

Replaces the "التسجيل الدوري - برنامج تعاهُد" Google Form with a small two-page
app: a public student check-in form and a password-gated admin dashboard.

Fully independent from the SIRIUS MCQ project — its own repo, its own Supabase
project, its own Vercel deployment.

## One-time setup

1. Create a new project at https://supabase.com/dashboard (e.g. named "taahud").
2. In the new project's SQL Editor, run the contents of `supabase-schema.sql`.
3. In Authentication → Users, add one user: email `admin@taahud.local`, password
   of your choice. This is the only login in the whole app — it's the admin
   account.
4. In Project Settings → API, copy the Project URL and the `anon` public key
   into `supabase-config.js` (`SUPABASE_URL` / `SUPABASE_ANON_KEY`).
5. In the admin dashboard (`admin.html`), log in and use the "الطلاب" tab to
   add your students (code + name) — there's no bulk import, add them one at a
   time.
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

## Deploying

Deploy the project root to Vercel as a static site (no build command needed).
`vercel.json` sets a few basic security headers.

## End-to-end QA checklist (run once after setup, and after any deploy)

- [ ] Student check-in form loads both dropdowns with the seeded roster.
- [ ] Submitting a session with a real student listener creates a `sessions`
      row with the correct `points_awarded` for the reciter and
      `listener_points_awarded` for the listener.
- [ ] Submitting with "وِرد استماع" or "شخص آخر خارج تعاهُد" creates listener
      points of `0`, while the reciter still gets their configured daily/page
      points.
- [ ] Admin login rejects a wrong password and accepts the right one.
- [ ] Admin can add/deactivate a student, and a deactivated student disappears
      from the check-in dropdowns.
- [ ] Admin stats table shows correct totals for day/week/month and sorts on
      column click.
- [ ] Admin session log lists every submission with readable names and filters
      correctly by student and method.
