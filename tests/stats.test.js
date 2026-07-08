"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  periodBounds,
  sessionInRange,
  aggregateStudentStats,
  sortStats,
  aggregateTotals,
  aggregateByField,
  topStudents,
  inactiveStudents,
} = require("../stats.js");

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

test("periodBounds: all spans the full representable date range", () => {
  const { start, end } = periodBounds("all", new Date(2026, 6, 8));
  assert.ok(start.getTime() < new Date(1900, 0, 1).getTime());
  assert.ok(end.getTime() > new Date(2200, 0, 1).getTime());
});

test("aggregateStudentStats: period 'all' includes sessions from any date", () => {
  const students = [{ id: "s1", code: "001", name: "Ahmed" }];
  const sessions = [
    { studentId: "s1", listenerType: "student", listenerStudentId: "s1", pages: 2, pointsAwarded: 1, createdAt: "2020-01-01T00:00:00" },
    { studentId: "s1", listenerType: "student", listenerStudentId: "s1", pages: 3, pointsAwarded: 1, createdAt: "2030-01-01T00:00:00" },
  ];
  const result = aggregateStudentStats(students, sessions, "all", new Date(2026, 6, 8));
  assert.equal(result[0].pagesRecited, 5);
  assert.equal(result[0].sessionsRecited, 2);
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
    {
      studentId: "s1",
      listenerType: "student",
      listenerStudentId: "s2",
      pages: 4,
      pointsAwarded: 13,
      listenerPointsAwarded: 9,
      createdAt: "2026-07-08T10:00:00",
    },
    // s2 recites 2 pages to s1, within range
    {
      studentId: "s2",
      listenerType: "student",
      listenerStudentId: "s1",
      pages: 2,
      pointsAwarded: 9,
      listenerPointsAwarded: 7,
      createdAt: "2026-07-09T10:00:00",
    },
    // s1 logs a listening-only session (no listener), within range
    {
      studentId: "s1",
      listenerType: "listening_only",
      listenerStudentId: null,
      pages: 3,
      pointsAwarded: 6,
      listenerPointsAwarded: 0,
      createdAt: "2026-07-08T12:00:00",
    },
    // s2 recites to s1, but the previous Friday (outside this week's range)
    {
      studentId: "s2",
      listenerType: "student",
      listenerStudentId: "s1",
      pages: 10,
      pointsAwarded: 25,
      listenerPointsAwarded: 15,
      createdAt: "2026-07-03T09:00:00",
    },
  ];

  const result = aggregateStudentStats(students, sessions, "week", new Date(2026, 6, 8));

  assert.deepEqual(result.find((r) => r.studentId === "s1"), {
    studentId: "s1", code: "001", name: "Ahmed",
    pagesRecited: 7, sessionsRecited: 2,
    pagesListened: 2, sessionsListened: 1,
    pointsEarned: 26,
  });
  assert.deepEqual(result.find((r) => r.studentId === "s2"), {
    studentId: "s2", code: "002", name: "Sara",
    pagesRecited: 2, sessionsRecited: 1,
    pagesListened: 4, sessionsListened: 1,
    pointsEarned: 18,
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

// ─── aggregateTotals ───

test("aggregateTotals: sums sessions/pages/points across everyone and counts distinct active students, excluding out-of-range sessions", () => {
  const sessions = [
    // s1 recites 4 pages to s2, within range
    {
      studentId: "s1",
      listenerType: "student",
      listenerStudentId: "s2",
      pages: 4,
      pointsAwarded: 13,
      listenerPointsAwarded: 9,
      createdAt: "2026-07-08T10:00:00",
    },
    // s2 recites 2 pages to s1, within range
    {
      studentId: "s2",
      listenerType: "student",
      listenerStudentId: "s1",
      pages: 2,
      pointsAwarded: 9,
      listenerPointsAwarded: 7,
      createdAt: "2026-07-09T10:00:00",
    },
    // s3 logs a listening-only session (no listener), within range
    {
      studentId: "s3",
      listenerType: "listening_only",
      listenerStudentId: null,
      pages: 3,
      pointsAwarded: 11,
      listenerPointsAwarded: 0,
      createdAt: "2026-07-08T12:00:00",
    },
    // s2 recites to s1 again, but the previous Friday (outside this week's range)
    {
      studentId: "s2",
      listenerType: "student",
      listenerStudentId: "s1",
      pages: 10,
      pointsAwarded: 25,
      listenerPointsAwarded: 15,
      createdAt: "2026-07-03T09:00:00",
    },
  ];

  const result = aggregateTotals(sessions, "week", new Date(2026, 6, 8));

  assert.deepEqual(result, {
    totalSessions: 3, // the Friday session falls outside the week
    totalPages: 9, // 4 + 2 + 3
    totalPoints: 49, // (13 + 9) + (9 + 7) + 11
    totalReciterPoints: 33,
    totalListenerPoints: 16,
    averagePages: 3,
    studentListenerSessions: 2,
    outsideSessions: 0,
    listeningOnlySessions: 1,
    activeStudents: 3, // s1, s2, s3 all appear at least once in range
  });
});

test("aggregateTotals: empty session list returns all zeros", () => {
  const result = aggregateTotals([], "month", new Date(2026, 6, 8));
  assert.deepEqual(result, {
    totalSessions: 0,
    totalPages: 0,
    totalPoints: 0,
    totalReciterPoints: 0,
    totalListenerPoints: 0,
    averagePages: 0,
    studentListenerSessions: 0,
    outsideSessions: 0,
    listeningOnlySessions: 0,
    activeStudents: 0,
  });
});

test("aggregateByField: groups sessions by a chosen dimension", () => {
  const sessions = [
    { method: "واتس", pages: 2, pointsAwarded: 9, listenerPointsAwarded: 7, createdAt: "2026-07-08T10:00:00" },
    { method: "واتس", pages: 3, pointsAwarded: 11, listenerPointsAwarded: 0, createdAt: "2026-07-08T11:00:00" },
    { method: "تليجرام", pages: 1, pointsAwarded: 7, listenerPointsAwarded: 6, createdAt: "2026-07-08T12:00:00" },
  ];

  assert.deepEqual(aggregateByField(sessions, "day", new Date(2026, 6, 8), "method", "غير محدد"), [
    { label: "واتس", sessions: 2, pages: 5, points: 27 },
    { label: "تليجرام", sessions: 1, pages: 1, points: 13 },
  ]);
});

test("topStudents and inactiveStudents: expose ranked dashboard slices", () => {
  const students = [
    { id: "s1", code: "1", name: "Ahmed" },
    { id: "s2", code: "2", name: "Sara" },
    { id: "s3", code: "3", name: "Youssef" },
  ];
  const sessions = [
    {
      studentId: "s1",
      listenerType: "student",
      listenerStudentId: "s2",
      pages: 4,
      pointsAwarded: 13,
      listenerPointsAwarded: 9,
      createdAt: "2026-07-08T10:00:00",
    },
  ];

  assert.deepEqual(topStudents(students, sessions, "day", new Date(2026, 6, 8), 2).map((s) => s.studentId), [
    "s1",
    "s2",
  ]);
  assert.deepEqual(inactiveStudents(students, sessions, "day", new Date(2026, 6, 8), 2).map((s) => s.studentId), [
    "s3",
  ]);
});
