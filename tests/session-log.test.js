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
