// ═══════════════════════════════════════════════════════════════
// Ta'ahud — Points calculation
// Pure, dependency-free logic shared by the check-in page (app.js)
// and Node tests. A session snapshots the points awarded to both
// participants so future settings changes never rewrite history.
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

  const DEFAULT_POINT_RULES = {
    dailyCheckin: 5,
    reciterPage: 2,
    listenerPage: 1,
  };

  function positiveInteger(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return Math.trunc(number);
  }

  function normalizePointRules(value) {
    const source = value || {};
    return {
      dailyCheckin: positiveInteger(source.dailyCheckin, DEFAULT_POINT_RULES.dailyCheckin),
      reciterPage: positiveInteger(source.reciterPage, DEFAULT_POINT_RULES.reciterPage),
      listenerPage: positiveInteger(source.listenerPage, DEFAULT_POINT_RULES.listenerPage),
    };
  }

  function localDayKey(value) {
    const date = new Date(value);
    return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
  }

  function previousLocalDayKey(value) {
    const date = new Date(value);
    date.setDate(date.getDate() - 1);
    return localDayKey(date);
  }

  function shouldAwardDailyCheckin(activeDayKeys, sessionDate) {
    const keys = new Set(activeDayKeys || []);
    const todayKey = localDayKey(sessionDate || new Date());
    if (keys.has(todayKey)) return false;
    if (!keys.size) return true;
    return keys.has(previousLocalDayKey(sessionDate || new Date()));
  }

  function computeSessionPoints(input) {
    const rules = normalizePointRules(input && input.pointRules);
    const pages = Math.max(0, Number(input && input.pages) || 0);
    const listenerType = input && input.listenerType;

    const reciterDailyPoints = input && input.awardReciterDailyCheckin ? rules.dailyCheckin : 0;
    const listenerDailyPoints =
      listenerType === "student" && input && input.awardListenerDailyCheckin ? rules.dailyCheckin : 0;

    return {
      reciterPoints: reciterDailyPoints + Math.trunc(pages * rules.reciterPage),
      listenerPoints:
        listenerType === "student" ? listenerDailyPoints + Math.trunc(pages * rules.listenerPage) : 0,
    };
  }

  return {
    DEFAULT_POINT_RULES,
    normalizePointRules,
    localDayKey,
    previousLocalDayKey,
    shouldAwardDailyCheckin,
    computeSessionPoints,
  };
});
