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

  function sessionPoints(session) {
    return (Number(session.pointsAwarded) || 0) + (Number(session.listenerPointsAwarded) || 0);
  }

  function aggregateStudentStats(students, sessions, period, referenceDate) {
    const inRange = sessionsInPeriod(sessions, period, referenceDate);

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
        pointsEarned:
          recited.reduce((sum, s) => sum + (Number(s.pointsAwarded) || 0), 0) +
          listened.reduce((sum, s) => sum + (Number(s.listenerPointsAwarded) || 0), 0),
      };
    });
  }

  function aggregateTotals(sessions, period, referenceDate) {
    const inRange = sessionsInPeriod(sessions, period, referenceDate);

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
    const totalReciterPoints = inRange.reduce((sum, s) => sum + (Number(s.pointsAwarded) || 0), 0);
    const totalListenerPoints = inRange.reduce((sum, s) => sum + (Number(s.listenerPointsAwarded) || 0), 0);

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

  function aggregateByField(sessions, period, referenceDate, field, fallback) {
    const inRange = sessionsInPeriod(sessions, period, referenceDate);
    const groups = new Map();
    inRange.forEach((session) => {
      const key = session[field] || fallback;
      const current = groups.get(key) || { label: key, sessions: 0, pages: 0, points: 0 };
      current.sessions += 1;
      current.pages += Number(session.pages) || 0;
      current.points += sessionPoints(session);
      groups.set(key, current);
    });
    return Array.from(groups.values()).sort((a, b) => b.sessions - a.sessions || b.pages - a.pages);
  }

  function topStudents(students, sessions, period, referenceDate, limit) {
    return sortStats(aggregateStudentStats(students, sessions, period, referenceDate), "pointsEarned", "desc")
      .filter((student) => student.sessionsRecited || student.sessionsListened || student.pointsEarned)
      .slice(0, limit || 5);
  }

  function inactiveStudents(students, sessions, period, referenceDate, limit) {
    return aggregateStudentStats(students, sessions, period, referenceDate)
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
    aggregateStudentStats,
    sortStats,
    aggregateTotals,
    aggregateByField,
    topStudents,
    inactiveStudents,
  };
});
