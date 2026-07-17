"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  periodBounds,
  filterSessionsByPeriod,
  aggregateStudentSessions,
  currentStreak,
} = require("../student-dashboard.js");

test("student periodBounds: week runs Saturday through Friday", () => {
  const bounds = periodBounds("week", new Date(2026, 6, 17, 18));
  assert.equal(bounds.start.getTime(), new Date(2026, 6, 11).getTime());
  assert.equal(bounds.end.getTime(), new Date(2026, 6, 18).getTime());
});

test("filterSessionsByPeriod: filters day, month, and all using sessionDate", () => {
  const sessions = [
    { id: "today", sessionDate: "2026-07-17" },
    { id: "month", sessionDate: "2026-07-02" },
    { id: "old", sessionDate: "2026-06-30" },
  ];
  const reference = new Date(2026, 6, 17, 20);

  assert.deepEqual(filterSessionsByPeriod(sessions, "day", reference).map((s) => s.id), ["today"]);
  assert.deepEqual(filterSessionsByPeriod(sessions, "month", reference).map((s) => s.id), ["today", "month"]);
  assert.equal(filterSessionsByPeriod(sessions, "all", reference).length, 3);
});

test("aggregateStudentSessions: separates reciter and listener activity", () => {
  const result = aggregateStudentSessions([
    { role: "reciter", pages: 4, points: 13 },
    { role: "listener", pages: 2, points: 7 },
    { role: "reciter", pages: 1.5, points: 3 },
  ]);

  assert.deepEqual(result, {
    totalPoints: 23,
    totalPages: 7.5,
    totalSessions: 3,
    reciterSessions: 2,
    reciterPages: 5.5,
    listenerSessions: 1,
    listenerPages: 2,
  });
});

test("currentStreak: counts through yesterday and stops at a missed day", () => {
  const sessions = [
    { sessionDate: "2026-07-16" },
    { sessionDate: "2026-07-15" },
    { sessionDate: "2026-07-13" },
  ];

  assert.equal(currentStreak(sessions, new Date(2026, 6, 17, 12)), 2);
});
