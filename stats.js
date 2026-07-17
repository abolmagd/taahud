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
    const effectiveDate = new Date(sessionEffectiveDate(session));
    return effectiveDate >= start && effectiveDate < end;
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

  function previousLocalDayKey(value) {
    const date = new Date(value);
    date.setDate(date.getDate() - 1);
    return localDayKey(date);
  }

  function sessionEffectiveDate(session) {
    return session.sessionDate || session.createdAt;
  }

  function sessionTimestamp(session) {
    const timestamp = new Date(sessionEffectiveDate(session)).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function shouldAwardDailyCheckin(activeDayKeys, sessionDate) {
    const dayKey = localDayKey(sessionDate);
    if (activeDayKeys.has(dayKey)) return false;
    if (!activeDayKeys.size) return true;
    return activeDayKeys.has(previousLocalDayKey(sessionDate));
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

    const dailyKeys = new Map();
    const ordered = sessions
      .map((session, index) => ({ session, index }))
      .sort((a, b) => sessionTimestamp(a.session) - sessionTimestamp(b.session) || a.index - b.index);
    const effectiveByIndex = new Map();

    ordered.forEach(({ session, index }) => {
      const pages = Math.max(0, Number(session.pages) || 0);
      const effectiveDate = sessionEffectiveDate(session);
      const dayKey = localDayKey(effectiveDate);
      const reciterDays = dailyKeys.get(session.studentId) || new Set();
      const awardReciterDaily = session.studentId && shouldAwardDailyCheckin(reciterDays, effectiveDate);
      if (session.studentId) {
        reciterDays.add(dayKey);
        dailyKeys.set(session.studentId, reciterDays);
      }

      let listenerPointsAwarded = 0;
      if (session.listenerType === "student" && session.listenerStudentId) {
        const listenerDays =
          session.listenerStudentId === session.studentId
            ? reciterDays
            : dailyKeys.get(session.listenerStudentId) || new Set();
        const awardListenerDaily =
          session.listenerStudentId === session.studentId
            ? awardReciterDaily
            : shouldAwardDailyCheckin(listenerDays, effectiveDate);
        listenerDays.add(dayKey);
        dailyKeys.set(session.listenerStudentId, listenerDays);
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

    const pageValues = inRange.map((s) => Number(s.pages) || 0).sort((a, b) => a - b);
    const totalPages = pageValues.reduce((sum, value) => sum + value, 0);
    const middle = Math.floor(pageValues.length / 2);
    const medianPages = !pageValues.length ? 0 : pageValues.length % 2
      ? pageValues[middle]
      : (pageValues[middle - 1] + pageValues[middle]) / 2;
    const totalReciterPoints = effectiveSessions.reduce((sum, item) => sum + item.pointsAwarded, 0);
    const totalListenerPoints = effectiveSessions.reduce((sum, item) => sum + item.listenerPointsAwarded, 0);

    return {
      totalSessions: inRange.length,
      totalPages,
      totalPoints: totalReciterPoints + totalListenerPoints,
      totalReciterPoints,
      totalListenerPoints,
      averagePages: inRange.length ? totalPages / inRange.length : 0,
      medianPages,
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

  function studentCurrentStreak(studentId, sessions, referenceDate) {
    const activeDays = new Set();
    sessions.forEach((session) => {
      if (session.studentId === studentId ||
          (session.listenerType === "student" && session.listenerStudentId === studentId)) {
        activeDays.add(localDayKey(sessionEffectiveDate(session)));
      }
    });
    const cursor = new Date(referenceDate);
    cursor.setHours(0, 0, 0, 0);
    if (!activeDays.has(localDayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while (activeDays.has(localDayKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function streakDistribution(students, sessions, referenceDate) {
    const groups = [
      { label: "بدون ستريك", sessions: 0 },
      { label: "١ - ٢ يوم", sessions: 0 },
      { label: "٣ - ٦ أيام", sessions: 0 },
      { label: "٧ أيام فأكثر", sessions: 0 },
    ];
    students.forEach((student) => {
      const streak = studentCurrentStreak(student.id, sessions, referenceDate);
      if (!streak) groups[0].sessions += 1;
      else if (streak <= 2) groups[1].sessions += 1;
      else if (streak <= 6) groups[2].sessions += 1;
      else groups[3].sessions += 1;
    });
    return groups;
  }

  function enrichStudentRoster(students, sessions) {
    const activity = new Map((students || []).map((student) => [student.id, { totalPoints: 0, lastActivity: null }]));
    (sessions || []).forEach((session) => {
      const timestamp = new Date(session.createdAt || session.sessionDate || 0).getTime();
      const update = (studentId, points) => {
        if (!studentId || !activity.has(studentId)) return;
        const current = activity.get(studentId);
        current.totalPoints += Number(points) || 0;
        if (Number.isFinite(timestamp) && (!current.lastActivity || timestamp > current.lastActivity)) {
          current.lastActivity = timestamp;
        }
      };
      update(session.studentId, session.pointsAwarded);
      if (session.listenerType === "student") {
        update(session.listenerStudentId, session.listenerPointsAwarded);
      }
    });
    return (students || []).map((student) => {
      const values = activity.get(student.id) || { totalPoints: 0, lastActivity: null };
      return Object.assign({}, student, values);
    });
  }

  function compareStudentCodes(a, b) {
    const first = Number(a.code);
    const second = Number(b.code);
    if (Number.isFinite(first) && Number.isFinite(second)) return first - second;
    return String(a.code).localeCompare(String(b.code), "ar", { numeric: true });
  }

  function sortStudentRoster(students, mode) {
    const sorted = (students || []).slice();
    sorted.sort((a, b) => {
      if (mode === "points-desc" || mode === "points-asc") {
        const direction = mode === "points-asc" ? 1 : -1;
        const difference = ((Number(a.totalPoints) || 0) - (Number(b.totalPoints) || 0)) * direction;
        return difference || compareStudentCodes(a, b);
      }
      if (mode === "newest") {
        const difference = new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        return difference || compareStudentCodes(a, b);
      }
      if (mode === "last-active") {
        const difference = (Number(b.lastActivity) || 0) - (Number(a.lastActivity) || 0);
        return difference || compareStudentCodes(a, b);
      }
      return compareStudentCodes(a, b);
    });
    return sorted;
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
    sessionEffectiveDate,
    withEffectivePoints,
    effectiveSessionPoints,
    aggregateStudentStats,
    sortStats,
    aggregateTotals,
    aggregateByField,
    topStudents,
    inactiveStudents,
    studentCurrentStreak,
    streakDistribution,
    enrichStudentRoster,
    sortStudentRoster,
  };
});
