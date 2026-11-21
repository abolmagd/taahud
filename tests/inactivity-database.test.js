"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const id = (n) => "00000000-0000-0000-0000-" + String(n).padStart(12, "0");

test("database warnings and monthly rank use shared activity, dates, and private access", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable
      as $$ select '00000000-0000-0000-0000-000000000999'::uuid $$;
    create table students (id uuid primary key, code text, name text, active boolean, created_at timestamptz);
    create table sessions (id serial primary key, student_id uuid, listener_student_id uuid,
      listener_type text default 'outside', session_kind text default 'recitation',
      session_date date, points_awarded numeric default 0, listener_points_awarded numeric default 0,
      deleted_at timestamptz, updated_at timestamptz, updated_by uuid);
    create table admin_audit_log (
      id uuid primary key default gen_random_uuid(), admin_id uuid, action text,
      entity_type text, entity_id uuid, old_data jsonb, new_data jsonb, reason text
    );
    create function taahud_current_local_date() returns date language sql stable
      as $$ select coalesce(nullif(current_setting('test.today', true), ''), '2026-10-21')::date $$;
    create function taahud_is_admin() returns boolean language sql stable
      as $$ select current_setting('test.admin', true) = 'true' $$;
    create function taahud_student_id_for_token(access_token text) returns uuid language sql stable
      as $$ select id from students where code = access_token and active $$;
  `);
  const migration = fs.readFileSync(path.join(__dirname, "../supabase-add-inactivity-warnings.sql"), "utf8");
  await db.exec(migration);
  // Applying again must be safe on existing deployments.
  await db.exec(migration);
  for (const [n, days, active] of [[1, 6, true], [2, 7, true], [3, 13, true], [4, 14, true],
    [5, 20, true], [6, 21, true], [7, 28, true], [8, 40, false]]) {
    await db.query(`insert into students values ($1, $2, $2, $3, '2026-10-21 12:00+03'::timestamptz - $4 * interval '1 day')`,
      [id(n), String(n), active, days]);
  }
  const status = async () => (await db.query("select * from taahud_inactivity_status() order by code")).rows;
  const warn = async (token) => (await db.query("select get_student_warnings($1) as data", [token])).rows[0].data;
  const rank = async (token) => (await db.query("select get_student_score_rank($1) as data", [token])).rows[0].data;

  await t.test("exact 7, 14, 21 day thresholds and additional weeks; disabled accounts excluded", async () => {
    assert.deepEqual((await status()).map((r) => [r.inactive_days, r.warning_count]),
      [[6, 0], [7, 1], [13, 1], [14, 2], [20, 2], [21, 3], [28, 4]]);
    assert.equal((await warn("2")).nextWarningDate, "2026-10-28");
  });

  await t.test("Cairo joining date, including after midnight, starts a full grace week", async () => {
    await db.query("insert into students values ($1, '9', 'new', true, '2026-10-14 22:30Z')", [id(9)]);
    assert.equal((await warn("9")).inactiveDays, 6);
    assert.equal((await warn("9")).warningCount, 0);
  });

  await t.test("reading, listening-only, deleted, and future sessions do not clear recitation warnings", async () => {
    for (const [kind, listenerType, date, deleted] of [
      ["reading", "outside", "2026-10-21", null],
      ["recitation", "listening_only", "2026-10-21", null],
      ["recitation", "outside", "2026-10-21", "2026-10-21"],
      ["recitation", "outside", "2026-10-22", null],
    ]) {
      await db.query(`insert into sessions (student_id, session_kind, listener_type, session_date, deleted_at)
        values ($1,$2,$3,$4,$5)`, [id(6), kind, listenerType, date, deleted]);
    }
    assert.equal((await warn("6")).warningCount, 3);
  });

  await t.test("both reciter and student listener recover, and deleting or editing activity recalculates", async () => {
    const { rows: [session] } = await db.query(`insert into sessions
      (student_id, listener_type, listener_student_id, session_date)
      values ($1,'student',$2,'2026-10-21') returning id`, [id(6), id(7)]);
    assert.equal((await warn("6")).warningCount, 0);
    assert.equal((await warn("7")).warningCount, 0);
    await db.query("update sessions set session_date = '2026-10-14' where id = $1", [session.id]);
    assert.equal((await warn("6")).warningCount, 1);
    await db.query("update sessions set deleted_at = now() where id = $1", [session.id]);
    assert.equal((await warn("6")).warningCount, 3);
    assert.equal((await warn("7")).warningCount, 4);
    await db.query("insert into sessions (student_id, session_kind, session_date) values ($1,'mutun','2026-10-21')", [id(7)]);
    assert.equal((await warn("7")).warningCount, 0);
  });

  await t.test("warnings advance without a new session or background job", async () => {
    await db.exec("set test.today = '2026-10-28'");
    assert.equal((await warn("4")).warningCount, 3);
    await db.exec("set test.today = '2026-10-21'");
  });

  await t.test("monthly ranking includes both roles, fractional points and ties; excludes old/deleted/inactive scores", async () => {
    await db.exec("delete from sessions");
    for (const [student, listener, date, points, listenerPoints, deleted] of [
      [1, null, "2026-09-30", 1000, 0, null],
      [1, null, "2026-10-01", 3.5, 0, null],
      [2, 3, "2026-10-21", 10, 10, null],
      [4, null, "2026-11-01", 500, 0, null],
      [4, null, "2026-10-21", 500, 0, "2026-10-21"],
      [8, null, "2026-10-21", 500, 0, null],
    ]) {
      await db.query(`insert into sessions (student_id, listener_student_id, listener_type,
        session_date, points_awarded, listener_points_awarded, deleted_at) values ($1,$2,$3,$4,$5,$6,$7)`,
        [id(student), listener ? id(listener) : null, listener ? "student" : "outside", date, points, listenerPoints, deleted]);
    }
    assert.deepEqual(await rank("1"), { rank: 3, totalStudents: 8, points: 3.5, period: "month", monthStart: "2026-10-01" });
    assert.equal((await rank("2")).rank, 1);
    assert.equal((await rank("3")).rank, 1);
    await db.exec("set test.today = '2026-11-01'");
    assert.equal((await rank("4")).points, 500);
    assert.equal((await rank("1")).points, 0);
    await db.exec("set test.today = '2026-10-21'");
  });

  await t.test("admin and student views agree, while anonymous requests cannot read other students", async () => {
    await db.exec("set test.admin = 'true'");
    const admin = (await db.query("select admin_get_student_warnings() as data")).rows[0].data;
    assert.equal(admin.find((r) => r.studentId === id(6)).warningCount, (await warn("6")).warningCount);
    await db.exec("set test.admin = 'false'; set role anon");
    await assert.rejects(() => db.query("select admin_get_student_warnings()"), /permission denied/);
    await assert.rejects(() => db.query("select * from taahud_inactivity_status()"), /permission denied/);
    await assert.rejects(() => warn("invalid"), /invalid_student_session/);
    await assert.rejects(() => warn("8"), /invalid_student_session/);
    assert.equal(typeof (await warn("6")).warningCount, "number");
    assert.equal((await rank("1")).points, 3.5);
    await db.exec("reset role; set role authenticated");
    await assert.rejects(() => db.query("select admin_get_student_warnings()"), /admin_required/);
    await db.exec("reset role");
  });

  await t.test("manual awards are authorized, idempotent, audited, and ranked by Cairo month", async () => {
    const awardsMigration = fs.readFileSync(path.join(__dirname, "../supabase-add-student-point-awards.sql"), "utf8");
    await db.exec(awardsMigration);
    await db.exec(awardsMigration);
    const award = async (student, points, reason, request) => (await db.query(
      "select admin_award_student_points($1,$2,$3,$4) as data", [id(student), points, reason, id(request)]
    )).rows[0].data;
    await db.exec("set role anon");
    await assert.rejects(() => award(1, 1, "مسابقة", 100), /permission denied/);
    await assert.rejects(() => db.query("select * from student_point_awards"), /permission denied/);
    await db.exec("reset role; set role authenticated; set test.admin = 'false'");
    await assert.rejects(() => award(1, 1, "مسابقة", 100), /admin_required/);
    assert.equal((await db.query("select * from student_point_awards")).rows.length, 0);

    await db.exec("set test.admin = 'true'");
    await assert.rejects(() => award(1, 0, "مسابقة", 100), /invalid_award_points/);
    await assert.rejects(() => award(1, 0.25, "مسابقة", 100), /invalid_award_points/);
    await assert.rejects(() => award(1, 1, " \t\n ", 100), /reason_required/);
    await assert.rejects(() => award(99, 1, "مسابقة", 100), /student_not_found/);
    assert.deepEqual(await award(1, 4.5, "  فائز في المسابقة  ", 100), { points: 4.5, awardedOn: "2026-10-21" });
    assert.deepEqual(await award(1, 4.5, "فائز في المسابقة", 100), { points: 4.5, awardedOn: "2026-10-21" });
    await assert.rejects(() => award(1, 6, "مسابقة أخرى", 100), /award_request_conflict/);
    await assert.rejects(() => db.query("update student_point_awards set points = 2000"), /permission denied/);
    await db.exec("reset role");

    const log = (await db.query("select * from admin_audit_log where action = 'award_points'")).rows;
    assert.equal(log.length, 1);
    assert.equal(log[0].entity_id, id(1));
    assert.equal(log[0].reason, "فائز في المسابقة");
    assert.equal(log[0].admin_id, id(999));
    assert.equal(log[0].new_data.points, 4.5);
    assert.equal((await warn("1")).warningCount, 0);

    await db.exec("set role anon");
    assert.deepEqual(await rank("1"), {
      rank: 3, totalStudents: 8, points: 8, leaderPoints: 10, previousPoints: 10,
      period: "month", monthStart: "2026-10-01", awardPoints: { day: 4.5, week: 4.5, all: 4.5 },
    });
    assert.equal((await rank("2")).previousPoints, null);
    assert.equal((await rank("3")).previousPoints, null);
    assert.equal((await rank("4")).previousPoints, 8);
    await db.exec("reset role; set test.today = '2026-11-01'");
    assert.equal((await rank("1")).points, 0);
    assert.equal((await rank("1")).awardPoints.all, 4.5);
    assert.equal((await rank("1")).awardPoints.week, 0);

    await db.exec("set role authenticated");
    await award(4, 2, "مسابقة", 101);
    assert.equal((await rank("4")).points, 502);
    const one = (await db.query("select admin_reset_student_points($1,'اختبار') as data", [id(4)])).rows[0].data;
    assert.equal(one.removedPoints, 502);
    assert.equal((await rank("4")).points, 0);
    await award(4, 2, "مسابقة", 101);
    assert.equal((await rank("4")).points, 0);
    await db.query("select admin_reset_all_points('اختبار')");
    assert.equal((await rank("1")).awardPoints.all, 0);
    await db.exec("reset role");
    assert.equal((await db.query("select count(*)::integer as count from admin_audit_log where action = 'award_points'")).rows[0].count, 2);
  });
});
