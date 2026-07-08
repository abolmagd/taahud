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

  function aggregateTotals(sessions, period, referenceDate) {
    const { start, end } = periodBounds(period, referenceDate);
    const inRange = sessions.filter((s) => sessionInRange(s, start, end));

    const activeStudentIds = new Set();
    inRange.forEach((s) => {
      if (s.studentId) activeStudentIds.add(s.studentId);
      if (s.listenerType === "student" && s.listenerStudentId) {
        activeStudentIds.add(s.listenerStudentId);
      }
    });

    return {
      totalSessions: inRange.length,
      totalPages: inRange.reduce((sum, s) => sum + (Number(s.pages) || 0), 0),
      totalPoints: inRange.reduce((sum, s) => sum + (Number(s.pointsAwarded) || 0), 0),
      activeStudents: activeStudentIds.size,
    };
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

  return { periodBounds, sessionInRange, aggregateStudentStats, sortStats, aggregateTotals };
});
