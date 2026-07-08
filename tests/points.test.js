"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_POINT_RULES, normalizePointRules, computeSessionPoints } = require("../points.js");

test("normalizePointRules: uses the 5/2/1 defaults", () => {
  assert.deepEqual(normalizePointRules(), DEFAULT_POINT_RULES);
});

test("computeSessionPoints: awards daily and page points to both real-student participants", () => {
  assert.deepEqual(
    computeSessionPoints({
      listenerType: "student",
      pages: 4,
      awardReciterDailyCheckin: true,
      awardListenerDailyCheckin: true,
      pointRules: { dailyCheckin: 5, reciterPage: 2, listenerPage: 1 },
    }),
    { reciterPoints: 13, listenerPoints: 9 }
  );
});

test("computeSessionPoints: daily check-in is independently optional for each participant", () => {
  assert.deepEqual(
    computeSessionPoints({
      listenerType: "student",
      pages: 3,
      awardReciterDailyCheckin: false,
      awardListenerDailyCheckin: true,
      pointRules: { dailyCheckin: 5, reciterPage: 2, listenerPage: 1 },
    }),
    { reciterPoints: 6, listenerPoints: 8 }
  );
});

test("computeSessionPoints: outside and listening-only sessions do not award listener points", () => {
  assert.deepEqual(
    computeSessionPoints({
      listenerType: "outside",
      pages: 2,
      awardReciterDailyCheckin: true,
      awardListenerDailyCheckin: true,
    }),
    { reciterPoints: 9, listenerPoints: 0 }
  );
  assert.deepEqual(
    computeSessionPoints({
      listenerType: "listening_only",
      pages: 2,
      awardReciterDailyCheckin: true,
      awardListenerDailyCheckin: true,
    }),
    { reciterPoints: 9, listenerPoints: 0 }
  );
});

test("computeSessionPoints: treats invalid rules and pages conservatively", () => {
  assert.deepEqual(
    computeSessionPoints({
      listenerType: "student",
      pages: "abc",
      awardReciterDailyCheckin: true,
      awardListenerDailyCheckin: true,
      pointRules: { dailyCheckin: -1, reciterPage: "x", listenerPage: undefined },
    }),
    { reciterPoints: 5, listenerPoints: 5 }
  );
});
