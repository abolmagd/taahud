"use strict";

const { chromium } = require("playwright");

const baseUrl = process.env.TAAHUD_BASE_URL || "http://127.0.0.1:4173";
const outputDir = process.env.TAAHUD_SCREENSHOT_DIR || "/tmp";

const students = [
  { id: "s1", code: "001", name: "أحمد محمد", active: true, created_at: "2026-07-01T10:00:00Z" },
  { id: "s2", code: "002", name: "سارة علي", active: true, created_at: "2026-07-02T10:00:00Z" },
  { id: "s3", code: "003", name: "يوسف حسن", active: false, created_at: "2026-07-03T10:00:00Z" },
];

const sessions = [
  {
    id: "x1", student_id: "s1", listener_type: "student", listener_student_id: "s2",
    pages: 5, method: "تليجرام", created_at: "2026-07-17T09:00:00Z", session_date: "2026-07-17",
    session_timing: "today", surah_range: "البقرة 1 - 10", satisfaction: "نعم تماما", notes: "جلسة جيدة",
    points_awarded: 15, listener_points_awarded: 10,
    student: { code: "001", name: "أحمد محمد" }, listener: { code: "002", name: "سارة علي" },
  },
  {
    id: "x2", student_id: "s2", listener_type: "outside", listener_student_id: null,
    pages: 3, method: "واتس", created_at: "2026-07-16T09:00:00Z", session_date: "2026-07-16",
    session_timing: "today", surah_range: "النساء", satisfaction: "يحتاج إلى مزيد من الضبط", notes: "",
    points_awarded: 11, listener_points_awarded: 0,
    student: { code: "002", name: "سارة علي" }, listener: null,
  },
];

async function installMock(page, admin) {
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.addInitScript(({ mockStudents, mockSessions, isAdmin }) => {
    function resultFor(table, single) {
      if (table === "students") return mockStudents;
      if (table === "sessions") return mockSessions;
      if (table === "settings") {
        const rules = { value: { dailyCheckin: 5, reciterPage: 2, listenerPage: 1 } };
        return single ? rules : [rules];
      }
      return [];
    }
    function query(table) {
      const builder = {
        single: false,
        select() { return builder; }, eq() { return builder; }, is() { return builder; },
        order() { return builder; }, range() { return builder; }, update() { return builder; },
        insert() { return builder; }, upsert() { return builder; },
        maybeSingle() { builder.single = true; return builder; },
        then(resolve, reject) {
          return Promise.resolve({ data: resultFor(table, builder.single), error: null }).then(resolve, reject);
        },
      };
      return builder;
    }
    const client = {
      from: query,
      rpc(name) {
        if (name === "student_login") {
          return Promise.resolve({ data: { accessToken: "token", student: mockStudents[0], mustChangePassword: false }, error: null });
        }
        if (name === "get_student_profile") {
          return Promise.resolve({ data: {
            student: mockStudents[0], mustChangePassword: false,
            sessions: [
              { id: "x1", sessionDate: "2026-07-17", createdAt: "2026-07-17T09:00:00Z", role: "reciter", counterpart: "002 - سارة علي", pages: 5, method: "تليجرام", points: 15 },
              { id: "x0", sessionDate: "2026-07-16", createdAt: "2026-07-16T09:00:00Z", role: "listener", counterpart: "002 - سارة علي", pages: 3, method: "واتس", points: 8 },
            ],
          }, error: null });
        }
        if (name === "list_active_student_codes") {
          return Promise.resolve({ data: mockStudents.slice(1).filter((student) => student.active).map(({ id, code }) => ({ id, code })), error: null });
        }
        if (name === "record_student_session") {
          return Promise.resolve({ data: { sessionDate: "2026-07-17", pointsAwarded: 15 }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      auth: {
        getSession() { return Promise.resolve({ data: { session: isAdmin ? { user: { email: "admin@taahud.local" } } : null } }); },
        signOut() { return Promise.resolve(); }, signInWithPassword() { return Promise.resolve({ error: null }); },
      },
      channel() { return { on() { return this; }, subscribe() { return this; } }; },
      removeChannel() {},
    };
    window.supabase = { createClient() { return client; } };
  }, { mockStudents: students, mockSessions: sessions, isAdmin: admin });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
    for (const kind of ["student", "admin"]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await installMock(page, kind === "admin");
      await page.goto(baseUrl + (kind === "admin" ? "/admin.html" : "/index.html"));
      if (kind === "student") {
        await page.fill("#login-code", "٠٠١");
        await page.fill("#login-password", "password1");
        await page.click("#student-login-btn");
        await page.waitForSelector("#student-dashboard:not([hidden])");
        const arabicCodeNormalized = await page.inputValue("#login-code") === "001";
        await page.check('input[name="listener-type"][value="student"]');
        const studentShowsCode = await page.locator("#listener-student-code-group").isVisible();
        await page.check('input[name="listener-type"][value="outside"]');
        const outsideHidesCode = !(await page.locator("#listener-student-code-group").isVisible());
        await page.check('input[name="listener-type"][value="listening_only"]');
        const listeningState = await page.evaluate(() => ({
          codeHidden: document.getElementById("listener-student-code-group").hidden,
          methodVisible: !document.getElementById("method-group").hidden,
          satisfactionHidden: document.getElementById("satisfaction-group").hidden,
        }));
        await page.evaluate((passed) => { window.__listenerTypeAudit = passed; },
          arabicCodeNormalized && studentShowsCode && outsideHidesCode && listeningState.codeHidden &&
          listeningState.methodVisible && listeningState.satisfactionHidden);
        await page.screenshot({ path: `${outputDir}/student-form-${viewport.name}-audit.png`, fullPage: true });
        await page.click('[data-student-view="stats"]');
      } else {
        await page.waitForSelector("#dashboard-view:not([hidden])");
        await page.click('[data-tab="roster"]');
        await page.selectOption("#roster-sort", "points-desc");
        await page.waitForFunction(() => document.querySelectorAll("#roster-body tr").length === 3);
      }
      await page.screenshot({ path: `${outputDir}/${kind}-${viewport.name}-audit.png`, fullPage: true });
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        hasMain: Boolean(document.querySelector("main")),
        visibleTextLength: document.body.innerText.length,
        duplicateIds: Array.from(document.querySelectorAll("[id]")).map((element) => element.id)
          .filter((id, index, ids) => ids.indexOf(id) !== index),
        unlabeledFields: Array.from(document.querySelectorAll("input:not([type=hidden]), select, textarea"))
          .filter((field) => !field.labels || !field.labels.length).map((field) => field.id),
        unnamedButtons: Array.from(document.querySelectorAll("button"))
          .filter((button) => !button.textContent.trim() && !button.getAttribute("aria-label")).length,
        rosterPointsDescending: !document.querySelector("#roster-sort") ||
          Array.from(document.querySelectorAll("#roster-body tr td:nth-child(4)"))
            .map((cell) => Number(cell.textContent)).every((value, index, values) => !index || values[index - 1] >= value),
        listenerTypesWork: window.__listenerTypeAudit !== false,
      }));
      results.push({ kind, viewport: viewport.name, errors, metrics });
      await page.close();
    }
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => result.errors.length || result.metrics.scrollWidth > result.metrics.clientWidth
    || result.metrics.duplicateIds.length || result.metrics.unlabeledFields.length || result.metrics.unnamedButtons
    || !result.metrics.rosterPointsDescending || !result.metrics.listenerTypesWork)) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
