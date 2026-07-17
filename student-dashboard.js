"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TaahudStudentDashboard = api;
})(typeof self !== "undefined" ? self : this, function () {
  function normalizeStudentCode(value) {
    return String(value == null ? "" : value)
      .trim()
      .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  }

  function localDate(value) {
    if (value instanceof Date) return new Date(value.getTime());
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const parts = value.split("-").map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }
    return new Date(value);
  }

  function sessionDate(session) {
    return localDate(session.sessionDate || session.createdAt);
  }

  function startOfDay(value) {
    const date = localDate(value);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function periodBounds(period, referenceDate) {
    const start = startOfDay(referenceDate || new Date());
    const end = new Date(start.getTime());

    if (period === "day") {
      end.setDate(end.getDate() + 1);
    } else if (period === "week") {
      const daysSinceSaturday = (start.getDay() + 1) % 7;
      start.setDate(start.getDate() - daysSinceSaturday);
      end.setTime(start.getTime());
      end.setDate(end.getDate() + 7);
    } else if (period === "month") {
      start.setDate(1);
      end.setTime(start.getTime());
      end.setMonth(end.getMonth() + 1);
    } else if (period === "all") {
      return { start: new Date(-8640000000000000), end: new Date(8640000000000000) };
    } else {
      throw new Error("Unknown student dashboard period: " + period);
    }

    return { start, end };
  }

  function filterSessionsByPeriod(sessions, period, referenceDate) {
    const bounds = periodBounds(period, referenceDate);
    return (sessions || []).filter((session) => {
      const date = sessionDate(session);
      return date >= bounds.start && date < bounds.end;
    });
  }

  function aggregateStudentSessions(sessions) {
    return (sessions || []).reduce(
      (totals, session) => {
        const pages = Number(session.pages) || 0;
        totals.totalPoints += Number(session.points) || 0;
        totals.totalPages += pages;
        totals.totalSessions += 1;

        if (session.role === "listener") {
          totals.listenerSessions += 1;
          totals.listenerPages += pages;
        } else {
          totals.reciterSessions += 1;
          totals.reciterPages += pages;
        }
        return totals;
      },
      {
        totalPoints: 0,
        totalPages: 0,
        totalSessions: 0,
        reciterSessions: 0,
        reciterPages: 0,
        listenerSessions: 0,
        listenerPages: 0,
      }
    );
  }

  function dayKey(value) {
    const date = localDate(value);
    return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
  }

  function currentStreak(sessions, referenceDate) {
    const activeDays = new Set((sessions || []).map((session) => dayKey(sessionDate(session))));
    if (!activeDays.size) return 0;

    const cursor = startOfDay(referenceDate || new Date());
    if (!activeDays.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    if (!activeDays.has(dayKey(cursor))) return 0;

    let streak = 0;
    while (activeDays.has(dayKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  return {
    normalizeStudentCode,
    periodBounds,
    filterSessionsByPeriod,
    aggregateStudentSessions,
    currentStreak,
  };
});
