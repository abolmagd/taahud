# تعاهُد (Ta'ahud) Recitation Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a two-page (student check-in + admin dashboard) web app that replaces the "تعاهُد" Google Form, automatically awarding points to listeners and giving the admin daily/weekly/monthly per-student stats.

**Architecture:** Vanilla HTML/CSS/JS, no build step. Pure business logic (points calculation, stats aggregation, session filtering) lives in small dependency-free UMD modules unit-tested with Node's built-in test runner, then loaded as classic `<script>` tags in the browser alongside a new, independent Supabase project (own DB, own Supabase Auth for the single admin account).

**Tech Stack:** HTML5, CSS3, vanilla JS (ES2017+), `@supabase/supabase-js@2` (via CDN), Supabase (Postgres + Auth), Node's built-in `node:test` for unit tests, Vercel for static hosting.

## Global Constraints

- Fully independent from the SIRIUS MCQ project — no shared files, no shared Supabase project. Repo root: `/Users/mac/Documents/Taahud` (already git-initialized; first commit is the design spec).
- No student login — students identify themselves by picking their code from a dropdown (public, no auth).
- Admin login is a single fixed account (`admin@taahud.local`) via Supabase Auth, presented to the user as just a password field.
- Points are snapshotted onto each session row at insert time (`points_awarded`), not computed live from the current setting, so later point-value changes never rewrite history.
- "Week" for stats = Saturday–Friday. "Month" = calendar month.
- Visual style reuses SIRIUS's dark/gold design tokens (exact values in Task 4), Figtree font, RTL layout, but branded "تعاهُد" — not SIRIUS.
- Spec of record: `docs/superpowers/specs/2026-07-08-taahud-design.md`.

---

### Task 1: Points calculation logic (`points.js`)

**Files:**
- Create: `package.json`
- Create: `points.js`
- Test: `tests/points.test.js`

**Interfaces:**
- Produces: `TaahudPoints.computeSessionPoints({ listenerType, pointValue }) -> number` (integer ≥ 0). Exposed as `module.exports.computeSessionPoints` under Node and `window.TaahudPoints.computeSessionPoints` in the browser (UMD).

- [ ] **Step 1: Create `package.json` with the test script**

```json
{
  "name": "taahud",
  "private": true,
  "scripts": {
    "test": "node --test tests/*.test.js"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/points.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeSessionPoints } = require("../points.js");

test("computeSessionPoints: awards the point value when the listener is a real student", () => {
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: 5 }), 5);
});

test("computeSessionPoints: awards zero when the listener is 'outside' or 'listening_only'", () => {
  assert.equal(computeSessionPoints({ listenerType: "outside", pointValue: 5 }), 0);
  assert.equal(computeSessionPoints({ listenerType: "listening_only", pointValue: 5 }), 0);
});

test("computeSessionPoints: treats a non-numeric or non-positive point value as zero", () => {
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: 0 }), 0);
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: -3 }), 0);
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: "abc" }), 0);
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: undefined }), 0);
});

test("computeSessionPoints: truncates a fractional point value to an integer", () => {
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: 5.9 }), 5);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../points.js'`

- [ ] **Step 4: Write the implementation**

Create `points.js`:

```js
// ═══════════════════════════════════════════════════════════════
// Ta'ahud — Points calculation
// Pure, dependency-free logic shared by the check-in page (app.js)
// and Node tests. Points are only ever awarded to a real student
// listener; "outside" and "listening_only" sessions award nothing.
// UMD/CommonJS because app.js is a classic script.
// ═══════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TaahudPoints = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function computeSessionPoints(input) {
    const listenerType = input && input.listenerType;
    if (listenerType !== "student") return 0;
    const value = Number(input.pointValue);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.trunc(value);
  }

  return { computeSessionPoints };
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 4 tests passing (`points.test.js`)

- [ ] **Step 6: Commit**

```bash
git add package.json points.js tests/points.test.js
git commit -m "Add points calculation logic with tests"
```

---

### Task 2: Stats aggregation & sorting logic (`stats.js`)

**Files:**
- Create: `stats.js`
- Test: `tests/stats.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (UMD global `TaahudStats` / CommonJS export):
  - `periodBounds(period, referenceDate) -> { start: Date, end: Date }` where `period` is `"day" | "week" | "month"`.
  - `sessionInRange(session, start, end) -> boolean` (checks `session.createdAt`).
  - `aggregateStudentStats(students, sessions, period, referenceDate) -> Array<{ studentId, code, name, pagesRecited, sessionsRecited, pagesListened, sessionsListened, pointsEarned }>` where `students` is `Array<{ id, code, name }>` and `sessions` is `Array<{ studentId, listenerType, listenerStudentId, pages, pointsAwarded, createdAt }>`.
  - `sortStats(stats, column, direction) -> Array` (non-mutating; `direction` is `"asc" | "desc"`).

- [ ] **Step 1: Write the failing tests**

Create `tests/stats.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { periodBounds, sessionInRange, aggregateStudentStats, sortStats } = require("../stats.js");

// ─── periodBounds ───

test("periodBounds: day returns midnight-to-midnight for the reference date", () => {
  const { start, end } = periodBounds("day", new Date(2026, 6, 8, 15, 30));
  assert.equal(start.getTime(), new Date(2026, 6, 8, 0, 0, 0).getTime());
  assert.equal(end.getTime(), new Date(2026, 6, 9, 0, 0, 0).getTime());
});

test("periodBounds: week is Saturday through Friday (Wed reference falls mid-week)", () => {
  const { start, end } = periodBounds("week", new Date(2026, 6, 8)); // Wed Jul 8 2026
  assert.equal(start.getTime(), new Date(2026, 6, 4, 0, 0, 0).getTime()); // Sat Jul 4
  assert.equal(end.getTime(), new Date(2026, 6, 11, 0, 0, 0).getTime()); // Sat Jul 11
});

test("periodBounds: week reference on a Saturday starts that same day", () => {
  const { start, end } = periodBounds("week", new Date(2026, 6, 4)); // Sat Jul 4
  assert.equal(start.getTime(), new Date(2026, 6, 4, 0, 0, 0).getTime());
  assert.equal(end.getTime(), new Date(2026, 6, 11, 0, 0, 0).getTime());
});

test("periodBounds: month returns first-of-month to first-of-next-month", () => {
  const { start, end } = periodBounds("month", new Date(2026, 6, 8));
  assert.equal(start.getTime(), new Date(2026, 6, 1, 0, 0, 0).getTime());
  assert.equal(end.getTime(), new Date(2026, 7, 1, 0, 0, 0).getTime());
});

test("periodBounds: unknown period throws", () => {
  assert.throws(() => periodBounds("year", new Date(2026, 6, 8)), /Unknown period/);
});

// ─── sessionInRange ───

test("sessionInRange: inside, before-start, and exactly-at-end boundary", () => {
  const start = new Date(2026, 6, 4);
  const end = new Date(2026, 6, 11);
  assert.equal(sessionInRange({ createdAt: "2026-07-10T23:00:00" }, start, end), true);
  assert.equal(sessionInRange({ createdAt: "2026-07-03T23:59:00" }, start, end), false);
  assert.equal(sessionInRange({ createdAt: "2026-07-11T00:00:00" }, start, end), false);
});

// ─── aggregateStudentStats ───

test("aggregateStudentStats: sums recited/listened pages, sessions, and points per student, excluding out-of-range sessions", () => {
  const students = [
    { id: "s1", code: "001", name: "Ahmed" },
    { id: "s2", code: "002", name: "Sara" },
    { id: "s3", code: "003", name: "Youssef" },
  ];
  const sessions = [
    // s1 recites 4 pages to s2, within range
    { studentId: "s1", listenerType: "student", listenerStudentId: "s2", pages: 4, pointsAwarded: 5, createdAt: "2026-07-08T10:00:00" },
    // s2 recites 2 pages to s1, within range
    { studentId: "s2", listenerType: "student", listenerStudentId: "s1", pages: 2, pointsAwarded: 5, createdAt: "2026-07-09T10:00:00" },
    // s1 logs a listening-only session (no listener), within range
    { studentId: "s1", listenerType: "listening_only", listenerStudentId: null, pages: 3, pointsAwarded: 0, createdAt: "2026-07-08T12:00:00" },
    // s2 recites to s1, but the previous Friday (outside this week's range)
    { studentId: "s2", listenerType: "student", listenerStudentId: "s1", pages: 10, pointsAwarded: 5, createdAt: "2026-07-03T09:00:00" },
  ];

  const result = aggregateStudentStats(students, sessions, "week", new Date(2026, 6, 8));

  assert.deepEqual(result.find((r) => r.studentId === "s1"), {
    studentId: "s1", code: "001", name: "Ahmed",
    pagesRecited: 7, sessionsRecited: 2,
    pagesListened: 2, sessionsListened: 1,
    pointsEarned: 5,
  });
  assert.deepEqual(result.find((r) => r.studentId === "s2"), {
    studentId: "s2", code: "002", name: "Sara",
    pagesRecited: 2, sessionsRecited: 1,
    pagesListened: 4, sessionsListened: 1,
    pointsEarned: 5,
  });
  assert.deepEqual(result.find((r) => r.studentId === "s3"), {
    studentId: "s3", code: "003", name: "Youssef",
    pagesRecited: 0, sessionsRecited: 0,
    pagesListened: 0, sessionsListened: 0,
    pointsEarned: 0,
  });
});

// ─── sortStats ───

test("sortStats: sorts numerically by a numeric column, descending", () => {
  const stats = [
    { studentId: "a", name: "A", pointsEarned: 3 },
    { studentId: "b", name: "B", pointsEarned: 10 },
    { studentId: "c", name: "C", pointsEarned: 1 },
  ];
  const sorted = sortStats(stats, "pointsEarned", "desc");
  assert.deepEqual(sorted.map((s) => s.studentId), ["b", "a", "c"]);
  // original array is untouched
  assert.deepEqual(stats.map((s) => s.studentId), ["a", "b", "c"]);
});

test("sortStats: sorts alphabetically by a string column, ascending", () => {
  const stats = [
    { studentId: "a", name: "Youssef", pointsEarned: 0 },
    { studentId: "b", name: "Ahmed", pointsEarned: 0 },
  ];
  const sorted = sortStats(stats, "name", "asc");
  assert.deepEqual(sorted.map((s) => s.studentId), ["b", "a"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../stats.js'`

- [ ] **Step 3: Write the implementation**

Create `stats.js`:

```js
// ═══════════════════════════════════════════════════════════════
// Ta'ahud — Stats aggregation
// Pure, dependency-free logic shared by the admin dashboard
// (admin.js) and Node tests. UMD/CommonJS because admin.js is a
// classic script.
// ═══════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TaahudStats = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Saturday-through-Friday week bounds ("week"), calendar month
  // bounds ("month"), or midnight-to-midnight ("day") for the given
  // reference date. Returned end is exclusive.
  function periodBounds(period, referenceDate) {
    const ref = new Date(referenceDate);
    if (period === "day") {
      const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return { start, end };
    }
    if (period === "week") {
      // JS getDay(): Sun=0 .. Sat=6. We want Sat=0 .. Fri=6.
      const daysSinceSaturday = (ref.getDay() + 1) % 7;
      const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - daysSinceSaturday);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return { start, end };
    }
    if (period === "month") {
      const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
      const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
      return { start, end };
    }
    throw new Error("Unknown period: " + period);
  }

  function sessionInRange(session, start, end) {
    const createdAt = new Date(session.createdAt);
    return createdAt >= start && createdAt < end;
  }

  function aggregateStudentStats(students, sessions, period, referenceDate) {
    const { start, end } = periodBounds(period, referenceDate);
    const inRange = sessions.filter((s) => sessionInRange(s, start, end));

    return students.map((student) => {
      const recited = inRange.filter((s) => s.studentId === student.id);
      const listened = inRange.filter(
        (s) => s.listenerType === "student" && s.listenerStudentId === student.id
      );
      return {
        studentId: student.id,
        code: student.code,
        name: student.name,
        pagesRecited: recited.reduce((sum, s) => sum + (Number(s.pages) || 0), 0),
        sessionsRecited: recited.length,
        pagesListened: listened.reduce((sum, s) => sum + (Number(s.pages) || 0), 0),
        sessionsListened: listened.length,
        pointsEarned: listened.reduce((sum, s) => sum + (Number(s.pointsAwarded) || 0), 0),
      };
    });
  }

  function sortStats(stats, column, direction) {
    const dir = direction === "asc" ? 1 : -1;
    return stats.slice().sort((a, b) => {
      const av = a[column];
      const bv = b[column];
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv), "ar") * dir;
      }
      return (Number(av) - Number(bv)) * dir;
    });
  }

  return { periodBounds, sessionInRange, aggregateStudentStats, sortStats };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all `stats.test.js` tests passing, plus the 4 from `points.test.js` (8 total)

- [ ] **Step 5: Commit**

```bash
git add stats.js tests/stats.test.js
git commit -m "Add stats aggregation and sorting logic with tests"
```

---

### Task 3: Session log filter logic (`session-log.js`)

**Files:**
- Create: `session-log.js`
- Test: `tests/session-log.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (UMD global `TaahudSessionLog` / CommonJS export): `filterSessions(sessions, filters) -> Array` where `sessions` is `Array<{ studentId, listenerStudentId, method, createdAt }>` and `filters` is `{ studentId?, method?, from?, to? }` (all optional). A session matches `studentId` if it appears as either reciter or listener.

- [ ] **Step 1: Write the failing tests**

Create `tests/session-log.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { filterSessions } = require("../session-log.js");

const sessions = [
  { id: "1", studentId: "s1", listenerStudentId: "s2", method: "تليجرام", createdAt: "2026-07-01T10:00:00" },
  { id: "2", studentId: "s2", listenerStudentId: "s1", method: "واتس", createdAt: "2026-07-05T10:00:00" },
  { id: "3", studentId: "s3", listenerStudentId: null, method: "استماع", createdAt: "2026-07-08T10:00:00" },
];

test("filterSessions: no filters returns everything", () => {
  assert.equal(filterSessions(sessions, {}).length, 3);
  assert.equal(filterSessions(sessions, undefined).length, 3);
});

test("filterSessions: studentId matches as reciter or as listener", () => {
  const result = filterSessions(sessions, { studentId: "s1" });
  assert.deepEqual(result.map((s) => s.id), ["1", "2"]);
});

test("filterSessions: method is an exact match", () => {
  const result = filterSessions(sessions, { method: "واتس" });
  assert.deepEqual(result.map((s) => s.id), ["2"]);
});

test("filterSessions: from/to bounds createdAt inclusive-start/exclusive-end", () => {
  const result = filterSessions(sessions, { from: "2026-07-02T00:00:00", to: "2026-07-08T10:00:00" });
  assert.deepEqual(result.map((s) => s.id), ["2"]);
});

test("filterSessions: filters combine with AND", () => {
  const result = filterSessions(sessions, { studentId: "s1", method: "واتس" });
  assert.deepEqual(result.map((s) => s.id), ["2"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../session-log.js'`

- [ ] **Step 3: Write the implementation**

Create `session-log.js`:

```js
// ═══════════════════════════════════════════════════════════════
// Ta'ahud — Session log filtering
// Pure, dependency-free logic shared by the admin dashboard
// (admin.js) and Node tests. UMD/CommonJS because admin.js is a
// classic script.
// ═══════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TaahudSessionLog = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function filterSessions(sessions, filters) {
    const f = filters || {};
    return sessions.filter((s) => {
      if (f.studentId && s.studentId !== f.studentId && s.listenerStudentId !== f.studentId) {
        return false;
      }
      if (f.method && s.method !== f.method) {
        return false;
      }
      if (f.from && new Date(s.createdAt) < new Date(f.from)) {
        return false;
      }
      if (f.to && new Date(s.createdAt) >= new Date(f.to)) {
        return false;
      }
      return true;
    });
  }

  return { filterSessions };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all `session-log.test.js` tests passing (13 total across all three modules)

- [ ] **Step 5: Commit**

```bash
git add session-log.js tests/session-log.test.js
git commit -m "Add session log filtering logic with tests"
```

---

### Task 4: Shared design tokens & page shells

**Files:**
- Create: `styles.css`
- Create: `index.html`
- Create: `admin.html`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS classes used by later tasks — `.page`, `.app-header`, `.card`, `.form-group`, `.btn`, `.btn-primary`, `.btn-secondary`, `.toast`, `.toast-success`, `.toast-error`, `.tabs`, `.tab`, `.tab.active`, `.table`, `.login-screen`.

- [ ] **Step 1: Create `styles.css`**

```css
/* ═══════════════════════════════════════════════════════════════
   تعاهُد — shared design tokens and base components
   Tokens copied from the SIRIUS MCQ platform's dark/gold theme
   (independent copy — this project has no shared files with SIRIUS).
   ═══════════════════════════════════════════════════════════════ */

:root {
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
  --shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
  --font-sans: "Figtree", "Noto Sans", ui-sans-serif, system-ui, -apple-system,
    BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  direction: rtl;
  text-align: right;
}

.page {
  max-width: 640px;
  margin: 0 auto;
  padding: 24px 16px 64px;
}

.app-header {
  text-align: center;
  margin-bottom: 24px;
}

.app-header h1 {
  color: var(--accent);
  font-size: 2rem;
  margin: 0 0 4px;
}

.muted {
  color: var(--muted);
  margin: 0;
}

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  padding: 24px;
  margin-bottom: 20px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 600;
  color: var(--text);
}

.form-group input,
.form-group select,
.form-group textarea {
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--surface-soft);
  color: var(--text);
  font-family: inherit;
  font-size: 1rem;
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.btn {
  display: inline-block;
  padding: 10px 20px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-family: inherit;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary {
  background: var(--accent);
  color: #1a1409;
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-secondary {
  background: transparent;
  color: var(--text);
  border-color: var(--line);
}

.toast {
  margin-top: 16px;
  padding: 12px 16px;
  border-radius: var(--radius-sm);
  font-weight: 600;
}

.toast-success {
  background: rgba(28, 114, 86, 0.2);
  color: var(--success);
  border: 1px solid var(--success);
}

.toast-error {
  background: rgba(167, 52, 52, 0.2);
  color: var(--danger);
  border: 1px solid var(--danger);
}

.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.tab {
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--surface-soft);
  color: var(--muted);
  cursor: pointer;
}

.tab.active {
  background: var(--accent);
  color: #1a1409;
  border-color: var(--accent);
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  text-align: right;
}

.table th {
  color: var(--accent);
  cursor: pointer;
  user-select: none;
}

.login-screen {
  max-width: 360px;
  margin: 80px auto;
}

hr.divider {
  border: none;
  border-top: 1px solid var(--line);
  margin: 16px 0;
}

[hidden] {
  display: none !important;
}
```

- [ ] **Step 2: Create `index.html`**

```html
<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>تعاهُد — تسجيل التسميع</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&display=swap" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="page">
    <header class="app-header">
      <h1>تعاهُد</h1>
      <p class="muted">سجّل ما تم تسميعه أو الاستماع إليه</p>
    </header>

    <main class="card" id="checkin-card">
      <form id="checkin-form" novalidate>
        <div class="form-group">
          <label for="student-code">الكود الخاص بك</label>
          <select id="student-code" required>
            <option value="">جارٍ التحميل...</option>
          </select>
        </div>

        <div class="form-group">
          <label for="listener-code">كود الحافظ الذي سمعت عليه</label>
          <select id="listener-code" required>
            <option value="">جارٍ التحميل...</option>
          </select>
        </div>

        <div class="form-group">
          <label for="pages">عدد الصفحات</label>
          <input type="number" id="pages" min="0" step="0.5" required />
        </div>

        <div class="form-group">
          <label for="surah-range">من (اختياري)</label>
          <input type="text" id="surah-range" placeholder="مثال: النساء ٣٣ - ٥٩" />
        </div>

        <div class="form-group">
          <label for="method">طريقة التسميع؟</label>
          <select id="method" required>
            <option value="">اختر...</option>
            <option value="تليجرام">تليجرام</option>
            <option value="واتس">واتس</option>
            <option value="مكالمة هاتفية">مكالمة هاتفية</option>
            <option value="جوجل ميت">جوجل ميت</option>
            <option value="مقابلة">مقابلة</option>
            <option value="استماع">استماع</option>
            <option value="أخرى">أخرى</option>
          </select>
        </div>

        <div class="form-group">
          <label for="satisfaction">هل أنت راض عن جودة محفوظك الذي سمعته؟</label>
          <select id="satisfaction" required>
            <option value="">اختر...</option>
            <option value="نعم تماما">نعم تماما</option>
            <option value="يحتاج إلى مزيد من الضبط">يحتاج إلى مزيد من الضبط</option>
            <option value="وردي كان ورد استماع">وردي كان ورد استماع</option>
          </select>
        </div>

        <div class="form-group">
          <label for="notes">ملاحظات واقتراحات (اختياري)</label>
          <textarea id="notes" rows="3"></textarea>
        </div>

        <button type="submit" class="btn btn-primary" id="submit-btn">تسجيل</button>
      </form>
      <div id="toast" class="toast" hidden></div>
    </main>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2" defer></script>
  <script src="supabase-config.js" defer></script>
  <script src="points.js" defer></script>
  <script src="app.js" defer></script>
</body>
</html>
```

Note: the original Google Form's satisfaction question had a fourth, empty-label choice alongside the three real ones — an artifact of the form export, not a meaningful option (an empty label is indistinguishable from the "اختر..." placeholder). It's intentionally not reproduced here.

- [ ] **Step 3: Create `admin.html`**

```html
<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>تعاهُد — لوحة الأدمن</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&display=swap" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="page" id="login-view">
    <div class="card login-screen">
      <h1 style="text-align:center;color:var(--accent);">تعاهُد</h1>
      <p class="muted" style="text-align:center;">لوحة الأدمن</p>
      <form id="login-form" novalidate>
        <div class="form-group">
          <label for="admin-password">كلمة المرور</label>
          <input type="password" id="admin-password" required />
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;">دخول</button>
      </form>
      <div id="login-toast" class="toast" hidden></div>
    </div>
  </div>

  <div class="page" id="dashboard-view" hidden>
    <header class="app-header" style="display:flex;justify-content:space-between;align-items:center;text-align:right;">
      <div>
        <h1 style="margin:0;">تعاهُد</h1>
        <p class="muted" style="margin:0;">لوحة الأدمن</p>
      </div>
      <button class="btn btn-secondary" id="logout-btn">خروج</button>
    </header>

    <nav class="tabs">
      <button class="tab active" data-tab="roster">الطلاب</button>
      <button class="tab" data-tab="settings">الإعدادات</button>
      <button class="tab" data-tab="stats">الإحصائيات</button>
      <button class="tab" data-tab="log">سجل الجلسات</button>
    </nav>

    <section class="card" id="tab-roster">
      <h2>الطلاب</h2>
      <form id="add-student-form" style="display:flex;gap:8px;align-items:flex-end;margin-bottom:16px;">
        <div class="form-group" style="flex:1;margin-bottom:0;">
          <label for="new-code">الكود</label>
          <input type="text" id="new-code" required />
        </div>
        <div class="form-group" style="flex:2;margin-bottom:0;">
          <label for="new-name">الاسم</label>
          <input type="text" id="new-name" required />
        </div>
        <button type="submit" class="btn btn-primary">إضافة</button>
      </form>
      <table class="table" id="roster-table">
        <thead>
          <tr><th>الكود</th><th>الاسم</th><th>الحالة</th><th></th></tr>
        </thead>
        <tbody id="roster-body"></tbody>
      </table>
    </section>

    <section class="card" id="tab-settings" hidden>
      <h2>الإعدادات</h2>
      <form id="settings-form">
        <div class="form-group">
          <label for="point-value">عدد النقاط لكل جلسة تسميع</label>
          <input type="number" id="point-value" min="0" step="1" required />
        </div>
        <button type="submit" class="btn btn-primary">حفظ</button>
      </form>
      <div id="settings-toast" class="toast" hidden></div>
    </section>

    <section class="card" id="tab-stats" hidden>
      <h2>الإحصائيات</h2>
      <nav class="tabs" id="period-tabs">
        <button class="tab active" data-period="day">اليوم</button>
        <button class="tab" data-period="week">الأسبوع</button>
        <button class="tab" data-period="month">الشهر</button>
      </nav>
      <table class="table" id="stats-table">
        <thead>
          <tr>
            <th data-col="name">الاسم</th>
            <th data-col="sessionsRecited">جلسات التسميع</th>
            <th data-col="pagesRecited">صفحات مسمّعة</th>
            <th data-col="sessionsListened">جلسات الاستماع</th>
            <th data-col="pagesListened">صفحات مستمع لها</th>
            <th data-col="pointsEarned">النقاط</th>
          </tr>
        </thead>
        <tbody id="stats-body"></tbody>
      </table>
    </section>

    <section class="card" id="tab-log" hidden>
      <h2>سجل الجلسات</h2>
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <select id="log-filter-student"><option value="">كل الطلاب</option></select>
        <select id="log-filter-method">
          <option value="">كل الطرق</option>
          <option value="تليجرام">تليجرام</option>
          <option value="واتس">واتس</option>
          <option value="مكالمة هاتفية">مكالمة هاتفية</option>
          <option value="جوجل ميت">جوجل ميت</option>
          <option value="مقابلة">مقابلة</option>
          <option value="استماع">استماع</option>
          <option value="أخرى">أخرى</option>
        </select>
      </div>
      <table class="table" id="log-table">
        <thead>
          <tr><th>التاريخ</th><th>الطالب</th><th>السامع</th><th>الصفحات</th><th>الطريقة</th></tr>
        </thead>
        <tbody id="log-body"></tbody>
      </table>
    </section>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2" defer></script>
  <script src="supabase-config.js" defer></script>
  <script src="stats.js" defer></script>
  <script src="session-log.js" defer></script>
  <script src="admin.js" defer></script>
</body>
</html>
```

- [ ] **Step 4: Verify structurally (no browser yet — Supabase isn't wired up until later tasks)**

Run:
```bash
node -e "
const fs = require('fs');
const index = fs.readFileSync('index.html', 'utf8');
const admin = fs.readFileSync('admin.html', 'utf8');
const mustHave = (html, id, label) => {
  if (!html.includes(id)) throw new Error(label + ' missing ' + id);
};
['student-code','listener-code','pages','surah-range','method','satisfaction','notes','submit-btn','toast']
  .forEach((id) => mustHave(index, 'id=\"' + id + '\"', 'index.html'));
['login-form','admin-password','dashboard-view','roster-table','settings-form','point-value','stats-table','log-table']
  .forEach((id) => mustHave(admin, 'id=\"' + id + '\"', 'admin.html'));
console.log('OK: all required element ids present');
"
```
Expected: `OK: all required element ids present`

If a browser preview tool is available, also open `index.html` and `admin.html` directly (e.g. via a local static server) and confirm visually: dark background, gold headings, right-to-left Arabic layout, and card-style panels — full interactive behavior can't be checked yet since `app.js`/`admin.js` don't exist until Tasks 6–9.

- [ ] **Step 5: Commit**

```bash
git add styles.css index.html admin.html
git commit -m "Add shared design tokens and page shells for check-in and admin pages"
```

---

### Task 5: Supabase schema and client config

**Files:**
- Create: `supabase-schema.sql`
- Create: `supabase-config.js`

**Interfaces:**
- Produces: `window._supabase` — an initialized `@supabase/supabase-js` client, consumed by `app.js` (Task 6) and `admin.js` (Tasks 7–9).

- [ ] **Step 1: Create `supabase-schema.sql`**

```sql
-- ═══════════════════════════════════════════════════════════════
-- Ta'ahud Database Schema
-- Go to Supabase Dashboard → SQL Editor → New Query and paste this.
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.students (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz default now()
);

create table if not exists public.sessions (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.students(id),
  listener_type       text not null check (listener_type in ('student','outside','listening_only')),
  listener_student_id uuid references public.students(id),
  pages               numeric not null check (pages >= 0),
  surah_range         text,
  method              text not null,
  satisfaction        text not null,
  notes               text,
  points_awarded      integer not null default 0,
  created_at          timestamptz default now()
);

create table if not exists public.settings (
  key   text primary key,
  value jsonb not null
);

insert into public.settings (key, value)
values ('point_value', '{"value": 1}'::jsonb)
on conflict (key) do nothing;

create index if not exists sessions_student_id_idx on public.sessions (student_id);
create index if not exists sessions_listener_student_id_idx on public.sessions (listener_student_id);
create index if not exists sessions_created_at_idx on public.sessions (created_at);

-- ═══════════════════════════════════════════════════════════════
-- Row Level Security
--
-- There is no student login anywhere in this app — students are
-- anonymous (anon key) and identify themselves only by picking a
-- code from a public dropdown. The single admin account is the only
-- thing that ever authenticates, so "authenticated" == "admin" here;
-- no separate is_admin() flag/table is needed (unlike the SIRIUS
-- MCQ project, which has many authenticated non-admin users).
-- ═══════════════════════════════════════════════════════════════

alter table public.students enable row level security;
alter table public.sessions enable row level security;
alter table public.settings enable row level security;

drop policy if exists "anyone_select_students" on public.students;
drop policy if exists "admin_write_students"   on public.students;
create policy "anyone_select_students" on public.students
  for select to anon, authenticated using (true);
create policy "admin_write_students" on public.students
  for all to authenticated using (true) with check (true);

drop policy if exists "anyone_insert_sessions" on public.sessions;
drop policy if exists "admin_read_sessions"     on public.sessions;
drop policy if exists "admin_write_sessions"    on public.sessions;
create policy "anyone_insert_sessions" on public.sessions
  for insert to anon, authenticated with check (true);
create policy "admin_read_sessions" on public.sessions
  for select to authenticated using (true);
create policy "admin_write_sessions" on public.sessions
  for all to authenticated using (true) with check (true);

drop policy if exists "anyone_select_settings" on public.settings;
drop policy if exists "admin_write_settings"   on public.settings;
create policy "anyone_select_settings" on public.settings
  for select to anon, authenticated using (true);
create policy "admin_write_settings" on public.settings
  for all to authenticated using (true) with check (true);
```

- [ ] **Step 2: Create `supabase-config.js`**

```js
// ─── Supabase ───
// Fill these in with your project's values from Supabase Dashboard →
// Project Settings → API, after running supabase-schema.sql there.
const SUPABASE_URL      = 'YOUR_SUPABASE_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

(function () {
  if (typeof window.supabase === 'undefined') {
    console.warn("[Ta'ahud] Supabase SDK not loaded — running in local-only mode");
    return;
  }
  window._supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'taahud.session',
    },
  });
  console.log("[Ta'ahud] Supabase connected ✓");
})();
```

- [ ] **Step 3: Verify the SQL is syntactically well-formed**

Run: `node -e "const s = require('fs').readFileSync('supabase-schema.sql','utf8'); if ((s.match(/create policy/g)||[]).length !== 8) throw new Error('expected 8 policies'); console.log('OK: schema has', (s.match(/create table/g)||[]).length, 'tables and 8 policies');"`
Expected: `OK: schema has 3 tables and 8 policies`

- [ ] **Step 4: Manual step — create the real Supabase project (you, the user, do this once)**

1. Go to https://supabase.com/dashboard → New Project. Name it "taahud".
2. Once provisioned, open SQL Editor → New Query, paste the contents of `supabase-schema.sql`, run it.
3. Go to Authentication → Users → Add User. Create exactly one user with email `admin@taahud.local` and a password of your choice — this is the admin login.
4. Go to Project Settings → API. Copy the "Project URL" and the "anon public" key.
5. Replace `YOUR_SUPABASE_PROJECT_URL` and `YOUR_SUPABASE_ANON_KEY` in `supabase-config.js` with those two values.

This step has no automated test — it's a one-time manual setup against your real Supabase account. Tasks 6–9 assume it's done before you do their manual end-to-end verification.

- [ ] **Step 5: Commit**

```bash
git add supabase-schema.sql supabase-config.js
git commit -m "Add Supabase schema, RLS policies, and client config"
```

---

### Task 6: Student check-in form wiring (`app.js`)

**Files:**
- Create: `app.js`

**Interfaces:**
- Consumes: `window._supabase` (Task 5), `window.TaahudPoints.computeSessionPoints` (Task 1), DOM element ids from `index.html` (Task 4).
- Produces: nothing consumed by later tasks (leaf of the dependency graph).

- [ ] **Step 1: Write a syntax-check "test" (no DOM/Supabase test harness for browser-wired files — matches this project's existing convention of only unit-testing pure logic modules)**

Run: `node -c app.js` (this will fail until the file exists — expected before Step 2)
Expected: FAIL — `Error: Cannot read file 'app.js'` (or similar "no such file")

- [ ] **Step 2: Write the implementation**

Create `app.js`:

```js
"use strict";

(function () {
  function getClient() {
    if (!window._supabase) {
      console.error("[Ta'ahud] Supabase client not initialized — check supabase-config.js");
      return null;
    }
    return window._supabase;
  }

  function showToast(message, kind) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.className = "toast toast-" + (kind || "success");
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 4000);
  }

  function populateSelect(select, options) {
    select.innerHTML = "";
    options.forEach((opt) => {
      const el = document.createElement("option");
      el.value = opt.value;
      el.textContent = opt.label;
      select.appendChild(el);
    });
  }

  async function loadStudents(client) {
    const { data, error } = await client
      .from("students")
      .select("id, code, name")
      .eq("active", true)
      .order("code", { ascending: true });
    if (error) {
      console.error("[Ta'ahud] Failed to load students", error);
      return [];
    }
    return data || [];
  }

  async function loadPointValue(client) {
    const { data, error } = await client
      .from("settings")
      .select("value")
      .eq("key", "point_value")
      .single();
    if (error || !data) {
      console.warn("[Ta'ahud] Failed to load point value, defaulting to 0", error);
      return 0;
    }
    return Number(data.value && data.value.value) || 0;
  }

  function readListenerSelection(value) {
    if (value === "__outside__") return { listenerType: "outside", listenerStudentId: null };
    if (value === "__listening_only__") return { listenerType: "listening_only", listenerStudentId: null };
    return { listenerType: "student", listenerStudentId: value };
  }

  async function init() {
    const client = getClient();
    if (!client) return;

    const studentSelect = document.getElementById("student-code");
    const listenerSelect = document.getElementById("listener-code");
    const form = document.getElementById("checkin-form");
    const submitBtn = document.getElementById("submit-btn");

    const students = await loadStudents(client);
    const studentOptions = students.map((s) => ({ value: s.id, label: s.code + " — " + s.name }));

    populateSelect(studentSelect, [{ value: "", label: "اختر..." }].concat(studentOptions));
    populateSelect(
      listenerSelect,
      [
        { value: "", label: "اختر..." },
        { value: "__outside__", label: "شخص آخر خارج تعاهُد" },
        { value: "__listening_only__", label: "وِرد استماع" },
      ].concat(studentOptions)
    );

    const pointValue = await loadPointValue(client);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submitBtn.disabled = true;

      const listenerSelection = readListenerSelection(listenerSelect.value);
      const payload = {
        student_id: studentSelect.value,
        listener_type: listenerSelection.listenerType,
        listener_student_id: listenerSelection.listenerStudentId,
        pages: Number(document.getElementById("pages").value),
        surah_range: document.getElementById("surah-range").value || null,
        method: document.getElementById("method").value,
        satisfaction: document.getElementById("satisfaction").value,
        notes: document.getElementById("notes").value || null,
        points_awarded: window.TaahudPoints.computeSessionPoints({
          listenerType: listenerSelection.listenerType,
          pointValue,
        }),
      };

      const { error } = await client.from("sessions").insert(payload);
      submitBtn.disabled = false;

      if (error) {
        console.error("[Ta'ahud] Failed to save session", error);
        showToast("حصل خطأ أثناء التسجيل، حاول تاني", "error");
        return;
      }

      showToast("تم تسجيل ورد التسميع بنجاح", "success");
      form.reset();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
```

- [ ] **Step 3: Run the syntax check to verify it passes**

Run: `node -c app.js`
Expected: no output, exit code 0

- [ ] **Step 4: Manual end-to-end verification (requires the Supabase project from Task 5, Step 4)**

1. Add at least two rows to `students` via the Supabase Table Editor (or wait for Task 7's roster UI).
2. Serve the project locally, e.g. `npx serve .` or `python3 -m http.server 8000`, and open `index.html` in a browser.
3. Confirm both dropdowns populate with the seeded students, plus the two special listener options.
4. Submit a session choosing a real student as listener. Confirm the success toast appears and the form resets.
5. In the Supabase Table Editor, confirm a new `sessions` row exists with `listener_type = 'student'` and `points_awarded` equal to the current `point_value` in `settings`.
6. Submit again choosing "وِرد استماع". Confirm the new row has `listener_type = 'listening_only'`, `listener_student_id = null`, and `points_awarded = 0`.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "Wire student check-in form to Supabase with automatic point awarding"
```

---

### Task 7: Admin login and student roster management (`admin.js`, part 1)

**Files:**
- Create: `admin.js`

**Interfaces:**
- Consumes: `window._supabase` (Task 5), DOM element ids from `admin.html` (Task 4).
- Produces: `window.TaahudAdmin.state.client` (the Supabase client, for Tasks 8–9 to reuse), `window.TaahudAdmin.switchTab(name)` (tab-switching helper Tasks 8–9 hook their own tabs into), `window.TaahudAdmin.loadActiveStudents()` (returns the same active-student list Tasks 8–9 need for dropdowns/lookups).

- [ ] **Step 1: Syntax-check placeholder (same rationale as Task 6 — no DOM/Supabase browser test harness in this project)**

Run: `node -c admin.js` (fails until the file exists)
Expected: FAIL — no such file

- [ ] **Step 2: Write the implementation**

Create `admin.js`:

```js
"use strict";

window.TaahudAdmin = (function () {
  const ADMIN_EMAIL = "admin@taahud.local";
  const state = { client: null };

  function getClient() {
    if (!window._supabase) {
      console.error("[Ta'ahud] Supabase client not initialized — check supabase-config.js");
      return null;
    }
    return window._supabase;
  }

  function showToast(elementId, message, kind) {
    const toast = document.getElementById(elementId);
    toast.textContent = message;
    toast.className = "toast toast-" + (kind || "success");
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 4000);
  }

  function showDashboard() {
    document.getElementById("login-view").hidden = true;
    document.getElementById("dashboard-view").hidden = false;
  }

  function showLogin() {
    document.getElementById("login-view").hidden = false;
    document.getElementById("dashboard-view").hidden = true;
  }

  function switchTab(name) {
    document.querySelectorAll(".tabs > .tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === name);
    });
    ["roster", "settings", "stats", "log"].forEach((tab) => {
      document.getElementById("tab-" + tab).hidden = tab !== name;
    });
  }

  async function loadActiveStudents() {
    const { data, error } = await state.client
      .from("students")
      .select("id, code, name, active")
      .eq("active", true)
      .order("code", { ascending: true });
    if (error) {
      console.error("[Ta'ahud] Failed to load students", error);
      return [];
    }
    return data || [];
  }

  async function loadAllStudents() {
    const { data, error } = await state.client
      .from("students")
      .select("id, code, name, active")
      .order("code", { ascending: true });
    if (error) {
      console.error("[Ta'ahud] Failed to load students", error);
      return [];
    }
    return data || [];
  }

  function renderRoster(students) {
    const body = document.getElementById("roster-body");
    body.innerHTML = "";
    students.forEach((student) => {
      const row = document.createElement("tr");

      const codeCell = document.createElement("td");
      codeCell.textContent = student.code;

      const nameCell = document.createElement("td");
      nameCell.textContent = student.name;

      const statusCell = document.createElement("td");
      statusCell.textContent = student.active ? "نشط" : "موقوف";

      const actionCell = document.createElement("td");
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "btn btn-secondary";
      toggleBtn.textContent = student.active ? "إيقاف" : "تفعيل";
      toggleBtn.addEventListener("click", async () => {
        await state.client.from("students").update({ active: !student.active }).eq("id", student.id);
        await refreshRoster();
      });
      actionCell.appendChild(toggleBtn);

      row.appendChild(codeCell);
      row.appendChild(nameCell);
      row.appendChild(statusCell);
      row.appendChild(actionCell);
      body.appendChild(row);
    });
  }

  async function refreshRoster() {
    const students = await loadAllStudents();
    renderRoster(students);
    return students;
  }

  function wireLogin() {
    const loginForm = document.getElementById("login-form");
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = document.getElementById("admin-password").value;
      const { error } = await state.client.auth.signInWithPassword({ email: ADMIN_EMAIL, password });
      if (error) {
        showToast("login-toast", "كلمة المرور غير صحيحة", "error");
        return;
      }
      showDashboard();
    });

    document.getElementById("logout-btn").addEventListener("click", async () => {
      await state.client.auth.signOut();
      showLogin();
    });
  }

  function wireTabs() {
    document.querySelectorAll(".tabs > .tab").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
  }

  function wireAddStudent() {
    document.getElementById("add-student-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const code = document.getElementById("new-code").value.trim();
      const name = document.getElementById("new-name").value.trim();
      if (!code || !name) return;
      const { error } = await state.client.from("students").insert({ code, name, active: true });
      if (error) {
        console.error("[Ta'ahud] Failed to add student", error);
        return;
      }
      document.getElementById("new-code").value = "";
      document.getElementById("new-name").value = "";
      await refreshRoster();
    });
  }

  async function init() {
    const client = getClient();
    if (!client) return;
    state.client = client;

    wireLogin();
    wireTabs();
    wireAddStudent();

    const {
      data: { session },
    } = await client.auth.getSession();

    if (session) {
      showDashboard();
      await refreshRoster();
    } else {
      showLogin();
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  return { state, switchTab, loadActiveStudents, refreshRoster };
})();
```

- [ ] **Step 3: Run the syntax check to verify it passes**

Run: `node -c admin.js`
Expected: no output, exit code 0

- [ ] **Step 4: Manual end-to-end verification (requires the Supabase project from Task 5, Step 4)**

1. Serve the project locally (same as Task 6, Step 4) and open `admin.html`.
2. Confirm the login screen shows (only a password field).
3. Enter the wrong password. Confirm the red "كلمة المرور غير صحيحة" toast appears.
4. Enter the correct password (set for `admin@taahud.local` in Task 5, Step 4). Confirm the dashboard appears with the "الطلاب" tab active and the seeded students listed.
5. Add a new student via the form. Confirm it appears in the table immediately.
6. Click "إيقاف" on a student. Confirm its status flips to "موقوف", and reopen `index.html` (Task 6) to confirm that student no longer appears in either dropdown.
7. Click "خروج". Confirm it returns to the login screen, and reloading the page keeps you logged out.

- [ ] **Step 5: Commit**

```bash
git add admin.js
git commit -m "Add admin login and student roster management"
```

---

### Task 8: Settings and stats dashboard (`admin.js`, part 2)

**Files:**
- Modify: `admin.js` (created in Task 7)

**Interfaces:**
- Consumes: `window.TaahudStats.aggregateStudentStats` / `sortStats` (Task 2), `loadActiveStudents()` and `state.client` (Task 7).
- Produces: nothing new consumed by later tasks (Task 9 adds its own tab independently).

- [ ] **Step 1: Insert the settings and stats logic**

In `admin.js`, insert the following block immediately before the `async function init() {` line:

```js
  async function loadPointValue() {
    const { data, error } = await state.client
      .from("settings")
      .select("value")
      .eq("key", "point_value")
      .single();
    if (error || !data) {
      console.error("[Ta'ahud] Failed to load point value", error);
      return 0;
    }
    return Number(data.value && data.value.value) || 0;
  }

  async function savePointValue(newValue) {
    const { error } = await state.client
      .from("settings")
      .update({ value: { value: newValue } })
      .eq("key", "point_value");
    return !error;
  }

  function wireSettings() {
    document.getElementById("settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const newValue = Number(document.getElementById("point-value").value);
      const ok = await savePointValue(newValue);
      showToast("settings-toast", ok ? "تم الحفظ" : "حصل خطأ أثناء الحفظ", ok ? "success" : "error");
    });
  }

  async function refreshSettingsForm() {
    document.getElementById("point-value").value = await loadPointValue();
  }

  let statsPeriod = "day";
  let statsSortColumn = "pointsEarned";
  let statsSortDirection = "desc";

  async function loadSessionsForStats() {
    const { data, error } = await state.client
      .from("sessions")
      .select("student_id, listener_type, listener_student_id, pages, points_awarded, created_at");
    if (error) {
      console.error("[Ta'ahud] Failed to load sessions", error);
      return [];
    }
    return data.map((row) => ({
      studentId: row.student_id,
      listenerType: row.listener_type,
      listenerStudentId: row.listener_student_id,
      pages: row.pages,
      pointsAwarded: row.points_awarded,
      createdAt: row.created_at,
    }));
  }

  function renderStatsTable(rows) {
    const body = document.getElementById("stats-body");
    body.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      [row.name, row.sessionsRecited, row.pagesRecited, row.sessionsListened, row.pagesListened, row.pointsEarned].forEach(
        (value) => {
          const td = document.createElement("td");
          td.textContent = value;
          tr.appendChild(td);
        }
      );
      body.appendChild(tr);
    });
  }

  async function refreshStats() {
    const [students, sessions] = await Promise.all([loadActiveStudents(), loadSessionsForStats()]);
    const aggregated = window.TaahudStats.aggregateStudentStats(students, sessions, statsPeriod, new Date());
    const sorted = window.TaahudStats.sortStats(aggregated, statsSortColumn, statsSortDirection);
    renderStatsTable(sorted);
  }

  function wireStatsControls() {
    document.querySelectorAll("#period-tabs > .tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#period-tabs > .tab").forEach((b) => b.classList.toggle("active", b === btn));
        statsPeriod = btn.dataset.period;
        refreshStats();
      });
    });

    document.querySelectorAll("#stats-table th[data-col]").forEach((th) => {
      th.addEventListener("click", () => {
        const column = th.dataset.col;
        if (statsSortColumn === column) {
          statsSortDirection = statsSortDirection === "asc" ? "desc" : "asc";
        } else {
          statsSortColumn = column;
          statsSortDirection = "desc";
        }
        refreshStats();
      });
    });
  }

```

- [ ] **Step 2: Wire the new tabs into `switchTab`**

Replace the existing `switchTab` function:

```js
  function switchTab(name) {
    document.querySelectorAll(".tabs > .tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === name);
    });
    ["roster", "settings", "stats", "log"].forEach((tab) => {
      document.getElementById("tab-" + tab).hidden = tab !== name;
    });
  }
```

with:

```js
  function switchTab(name) {
    document.querySelectorAll(".tabs > .tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === name);
    });
    ["roster", "settings", "stats", "log"].forEach((tab) => {
      document.getElementById("tab-" + tab).hidden = tab !== name;
    });
    if (name === "settings") refreshSettingsForm();
    if (name === "stats") refreshStats();
  }
```

- [ ] **Step 3: Wire the new controls in `init`**

Replace:

```js
    wireLogin();
    wireTabs();
    wireAddStudent();
```

with:

```js
    wireLogin();
    wireTabs();
    wireAddStudent();
    wireSettings();
    wireStatsControls();
```

- [ ] **Step 4: Run the syntax check**

Run: `node -c admin.js`
Expected: no output, exit code 0

- [ ] **Step 5: Manual end-to-end verification**

1. Reload `admin.html`, log in, go to "الإعدادات". Confirm the current point value loads into the field.
2. Change it (e.g. to `3`) and save. Confirm the green "تم الحفظ" toast.
3. Go to `index.html` and submit a new session with a real student listener. Confirm (via Supabase Table Editor) the new row's `points_awarded` is `3`, while older rows keep their original values.
4. Back in `admin.html`, go to "الإحصائيات". Confirm the table lists every active student, with correct counts for "اليوم" (today).
5. Click "الأسبوع" and "الشهر". Confirm the numbers change appropriately (should be ≥ the daily numbers).
6. Click the "النقاط" column header twice. Confirm the sort order reverses.

- [ ] **Step 6: Commit**

```bash
git add admin.js
git commit -m "Add point-value settings and per-student stats dashboard"
```

---

### Task 9: Session log tab (`admin.js`, part 3)

**Files:**
- Modify: `admin.js` (created in Task 7, extended in Task 8)

**Interfaces:**
- Consumes: `window.TaahudSessionLog.filterSessions` (Task 3), `loadActiveStudents()` and `state.client` (Task 7).
- Produces: nothing consumed elsewhere (final leaf task).

- [ ] **Step 1: Insert the session log logic**

In `admin.js`, insert the following block immediately before the `async function init() {` line (after the Task 8 stats block):

```js
  let allLogSessions = [];

  async function loadSessionsForLog() {
    const { data, error } = await state.client
      .from("sessions")
      .select(
        "id, pages, method, listener_type, created_at, student_id, listener_student_id, " +
          "student:student_id(code, name), listener:listener_student_id(code, name)"
      )
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[Ta'ahud] Failed to load session log", error);
      return [];
    }
    return data.map((row) => ({
      id: row.id,
      studentId: row.student_id,
      listenerStudentId: row.listener_student_id,
      method: row.method,
      createdAt: row.created_at,
      pages: row.pages,
      studentLabel: row.student ? row.student.code + " — " + row.student.name : "",
      listenerLabel:
        row.listener_type === "outside"
          ? "شخص آخر خارج تعاهُد"
          : row.listener_type === "listening_only"
          ? "وِرد استماع"
          : row.listener
          ? row.listener.code + " — " + row.listener.name
          : "",
    }));
  }

  function renderLogTable(rows) {
    const body = document.getElementById("log-body");
    body.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      [new Date(row.createdAt).toLocaleString("ar-EG"), row.studentLabel, row.listenerLabel, row.pages, row.method].forEach(
        (value) => {
          const td = document.createElement("td");
          td.textContent = value;
          tr.appendChild(td);
        }
      );
      body.appendChild(tr);
    });
  }

  function applyLogFilters() {
    const studentId = document.getElementById("log-filter-student").value;
    const method = document.getElementById("log-filter-method").value;
    const filtered = window.TaahudSessionLog.filterSessions(allLogSessions, { studentId, method });
    renderLogTable(filtered);
  }

  async function refreshLog() {
    allLogSessions = await loadSessionsForLog();
    applyLogFilters();
  }

  async function populateLogStudentFilter() {
    const students = await loadActiveStudents();
    const select = document.getElementById("log-filter-student");
    select.innerHTML = '<option value="">كل الطلاب</option>';
    students.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.code + " — " + s.name;
      select.appendChild(opt);
    });
  }

  function wireLogControls() {
    document.getElementById("log-filter-student").addEventListener("change", applyLogFilters);
    document.getElementById("log-filter-method").addEventListener("change", applyLogFilters);
  }

```

- [ ] **Step 2: Wire the log tab into `switchTab`**

Replace:

```js
    if (name === "settings") refreshSettingsForm();
    if (name === "stats") refreshStats();
  }
```

with:

```js
    if (name === "settings") refreshSettingsForm();
    if (name === "stats") refreshStats();
    if (name === "log") {
      populateLogStudentFilter();
      refreshLog();
    }
  }
```

- [ ] **Step 3: Wire the log controls in `init`**

Replace:

```js
    wireLogin();
    wireTabs();
    wireAddStudent();
    wireSettings();
    wireStatsControls();
```

with:

```js
    wireLogin();
    wireTabs();
    wireAddStudent();
    wireSettings();
    wireStatsControls();
    wireLogControls();
```

- [ ] **Step 4: Run the syntax check**

Run: `node -c admin.js`
Expected: no output, exit code 0

- [ ] **Step 5: Manual end-to-end verification**

1. Reload `admin.html`, log in, go to "سجل الجلسات". Confirm every session submitted in earlier tasks' manual tests appears, newest first, with readable student/listener names (not raw UUIDs) and the correct special labels for "شخص آخر خارج تعاهُد" / "وِرد استماع" rows.
2. Filter by a specific student in the dropdown. Confirm only sessions where that student is reciter or listener remain.
3. Filter by a method (e.g. "واتس"). Confirm only matching rows remain, combined correctly with the student filter still applied.
4. Clear both filters. Confirm the full list returns.

- [ ] **Step 6: Commit**

```bash
git add admin.js
git commit -m "Add filterable session log tab to admin dashboard"
```

---

### Task 10: Deployment config and setup guide

**Files:**
- Create: `vercel.json`
- Create: `README.md`

**Interfaces:**
- Consumes: nothing (deployment/documentation wrapper around all prior tasks).
- Produces: nothing (final task).

- [ ] **Step 1: Create `vercel.json`**

```json
{
  "cleanUrls": true,
  "trailingSlash": false,
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Create `README.md`**

```markdown
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
6. In the "الإعدادات" tab, set how many points a session should award its
   listener.

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
      row with the correct `points_awarded`.
- [ ] Submitting with "وِرد استماع" or "شخص آخر خارج تعاهُد" creates a row with
      `points_awarded = 0`.
- [ ] Admin login rejects a wrong password and accepts the right one.
- [ ] Admin can add/deactivate a student, and a deactivated student disappears
      from the check-in dropdowns.
- [ ] Admin stats table shows correct totals for day/week/month and sorts on
      column click.
- [ ] Admin session log lists every submission with readable names and filters
      correctly by student and method.
```

- [ ] **Step 3: Verify both files are valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('OK: vercel.json is valid JSON')"`
Expected: `OK: vercel.json is valid JSON`

- [ ] **Step 4: Commit**

```bash
git add vercel.json README.md
git commit -m "Add deployment config and setup/QA guide"
```

---

## Plan self-review

**Spec coverage:** every section of `docs/superpowers/specs/2026-07-08-taahud-design.md` maps to a task — §3 architecture (Tasks 1, 4–7), §4 data model/RLS (Task 5), §5 check-in form (Tasks 4, 6), §6 admin panel (Tasks 4, 7–9), §7 visual style (Task 4), and the "why real auth" note (Task 5's RLS design, Task 7's login). No spec requirement was left without a task.

**Placeholders:** none — every step has complete, runnable code or an exact command with expected output.

**Type/interface consistency:** `computeSessionPoints({ listenerType, pointValue })` (Task 1) is called identically in `app.js` (Task 6) and would be in `admin.js` if ever needed for recalculation (it isn't — points are only computed at insertion time in `app.js`). `aggregateStudentStats`/`sortStats` (Task 2) and `filterSessions` (Task 3) are called with the same field names (`studentId`, `listenerType`, `listenerStudentId`, `pointsAwarded`, `createdAt`) in both their tests and their Task 8/9 call sites in `admin.js`, which map Supabase's snake_case columns to these exact camelCase keys before calling in. `window.TaahudAdmin`'s exposed surface (`state`, `switchTab`, `loadActiveStudents`, `refreshRoster`) matches what Tasks 8–9 actually consume (`state.client`, `loadActiveStudents()`) — Tasks 8–9 add their own functions as closures inside the same IIFE rather than through the public return, which is fine since they're inserted textually into the same function scope.
