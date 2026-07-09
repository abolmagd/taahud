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
    if (period === "all") {
      return { start: new Date(-8640000000000000), end: new Date(8640000000000000) };
    }
    throw new Error("Unknown period: " + period);
  }

  function sessionInRange(session, start, end) {
    const createdAt = new Date(session.createdAt);
    return createdAt >= start && createdAt < end;
  }

  function sessionsInPeriod(sessions, period, referenceDate) {
    const { start, end } = periodBounds(period, referenceDate);
    return sessions.filter((s) => sessionInRange(s, start, end));
  }

  function normalizePointRules(pointRules) {
    if (!pointRules) return null;
    return {
      dailyCheckin: positiveInteger(pointRules.dailyCheckin, 5),
      reciterPage: positiveInteger(pointRules.reciterPage, 2),
      listenerPage: positiveInteger(pointRules.listenerPage, 1),
    };
  }

  function positiveInteger(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return Math.trunc(number);
  }

  function localDayKey(value) {
    const date = new Date(value);
    return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
  }

  function sessionTimestamp(session) {
    const timestamp = new Date(session.createdAt).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function withEffectivePoints(sessions, pointRules) {
    const rules = normalizePointRules(pointRules);
    if (!rules) {
      return sessions.map((session) => ({
        session,
        pointsAwarded: Number(session.pointsAwarded) || 0,
        listenerPointsAwarded: Number(session.listenerPointsAwarded) || 0,
      }));
    }

    const dailyKeys = new Set();
    const ordered = sessions
      .map((session, index) => ({ session, index }))
      .sort((a, b) => sessionTimestamp(a.session) - sessionTimestamp(b.session) || a.index - b.index);
    const effectiveByIndex = new Map();

    ordered.forEach(({ session, index }) => {
      const pages = Math.max(0, Number(session.pages) || 0);
      const dayKey = localDayKey(session.createdAt);
      const reciterKey = session.studentId + "|" + dayKey;
      const awardReciterDaily = session.studentId && !dailyKeys.has(reciterKey);
      if (session.studentId) dailyKeys.add(reciterKey);

      let listenerPointsAwarded = 0;
      if (session.listenerType === "student" && session.listenerStudentId) {
        const listenerKey = session.listenerStudentId + "|" + dayKey;
        const awardListenerDaily = !dailyKeys.has(listenerKey);
        dailyKeys.add(listenerKey);
        listenerPointsAwarded =
          (awardListenerDaily ? rules.dailyCheckin : 0) + Math.trunc(pages * rules.listenerPage);
      }

      effectiveByIndex.set(index, {
        session,
        pointsAwarded: (awardReciterDaily ? rules.dailyCheckin : 0) + Math.trunc(pages * rules.reciterPage),
        listenerPointsAwarded,
      });
    });

    return sessions.map((session, index) => effectiveByIndex.get(index));
  }

  function effectiveSessionPoints(session, pointRules) {
    const [effective] = withEffectivePoints([session], pointRules);
    return effective.pointsAwarded + effective.listenerPointsAwarded;
  }

  function aggregateStudentStats(students, sessions, period, referenceDate, pointRules) {
    const inRange = sessionsInPeriod(sessions, period, referenceDate);
    const effectiveSessions = withEffectivePoints(inRange, pointRules);

    return students.map((student) => {
      const recited = effectiveSessions.filter(({ session }) => session.studentId === student.id);
      const listened = effectiveSessions.filter(
        ({ session }) => session.listenerType === "student" && session.listenerStudentId === student.id
      );
      return {
        studentId: student.id,
        code: student.code,
        name: student.name,
        pagesRecited: recited.reduce((sum, item) => sum + (Number(item.session.pages) || 0), 0),
        sessionsRecited: recited.length,
        pagesListened: listened.reduce((sum, item) => sum + (Number(item.session.pages) || 0), 0),
        sessionsListened: listened.length,
        pointsEarned:
          recited.reduce((sum, item) => sum + item.pointsAwarded, 0) +
          listened.reduce((sum, item) => sum + item.listenerPointsAwarded, 0),
      };
    });
  }

  function aggregateTotals(sessions, period, referenceDate, pointRules) {
    const inRange = sessionsInPeriod(sessions, period, referenceDate);
    const effectiveSessions = withEffectivePoints(inRange, pointRules);

    const activeStudentIds = new Set();
    let studentListenerSessions = 0;
    let outsideSessions = 0;
    let listeningOnlySessions = 0;
    inRange.forEach((s) => {
      if (s.studentId) activeStudentIds.add(s.studentId);
      if (s.listenerType === "student" && s.listenerStudentId) {
        studentListenerSessions += 1;
        activeStudentIds.add(s.listenerStudentId);
      } else if (s.listenerType === "outside") {
        outsideSessions += 1;
      } else if (s.listenerType === "listening_only") {
        listeningOnlySessions += 1;
      }
    });

    const totalPages = inRange.reduce((sum, s) => sum + (Number(s.pages) || 0), 0);
    const totalReciterPoints = effectiveSessions.reduce((sum, item) => sum + item.pointsAwarded, 0);
    const totalListenerPoints = effectiveSessions.reduce((sum, item) => sum + item.listenerPointsAwarded, 0);

    return {
      totalSessions: inRange.length,
      totalPages,
      totalPoints: totalReciterPoints + totalListenerPoints,
      totalReciterPoints,
      totalListenerPoints,
      averagePages: inRange.length ? totalPages / inRange.length : 0,
      studentListenerSessions,
      outsideSessions,
      listeningOnlySessions,
      activeStudents: activeStudentIds.size,
    };
  }

  function aggregateByField(sessions, period, referenceDate, field, fallback, pointRules) {
    const inRange = sessionsInPeriod(sessions, period, referenceDate);
    const effectiveSessions = withEffectivePoints(inRange, pointRules);
    const groups = new Map();
    effectiveSessions.forEach((item) => {
      const session = item.session;
      const key = session[field] || fallback;
      const current = groups.get(key) || { label: key, sessions: 0, pages: 0, points: 0 };
      current.sessions += 1;
      current.pages += Number(session.pages) || 0;
      current.points += item.pointsAwarded + item.listenerPointsAwarded;
      groups.set(key, current);
    });
    return Array.from(groups.values()).sort((a, b) => b.sessions - a.sessions || b.pages - a.pages);
  }

  function topStudents(students, sessions, period, referenceDate, limit, pointRules) {
    return sortStats(aggregateStudentStats(students, sessions, period, referenceDate, pointRules), "pointsEarned", "desc")
      .filter((student) => student.sessionsRecited || student.sessionsListened || student.pointsEarned)
      .slice(0, limit || 5);
  }

  function inactiveStudents(students, sessions, period, referenceDate, limit, pointRules) {
    return aggregateStudentStats(students, sessions, period, referenceDate, pointRules)
      .filter((student) => !student.sessionsRecited && !student.sessionsListened)
      .slice(0, limit || 8);
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

  return {
    periodBounds,
    sessionInRange,
    sessionsInPeriod,
    withEffectivePoints,
    effectiveSessionPoints,
    aggregateStudentStats,
    sortStats,
    aggregateTotals,
    aggregateByField,
    topStudents,
    inactiveStudents,
  };
});
