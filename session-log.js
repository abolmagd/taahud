// ═══════════════════════════════════════════════════════════════
// Ta'ahud — Session log filtering
// Pure, dependency-free logic shared by the admin dashboard
// (admin.js) and Node tests. UMD/CommonJS because admin.js is a
// classic script.
// ═══════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TaahudSessionLog = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function filterSessions(sessions, filters) {
    const f = filters || {};
    return sessions.filter((s) => {
      if (f.studentId && s.studentId !== f.studentId && s.listenerStudentId !== f.studentId) {
        return false;
      }
      if (f.method && s.method !== f.method) {
        return false;
      }
      if (f.listenerType && s.listenerType !== f.listenerType) {
        return false;
      }
      const effectiveDate = String(s.sessionDate || s.createdAt || "").slice(0, 10);
      if (f.from && effectiveDate < f.from) {
        return false;
      }
      if (f.to && effectiveDate > f.to) {
        return false;
      }
      const query = String(f.search || "").trim().toLocaleLowerCase("ar");
      if (query) {
        const haystack = [s.studentLabel, s.listenerLabel, s.notes, s.surahRange, s.method]
          .filter(Boolean).join(" ").toLocaleLowerCase("ar");
        if (!haystack.includes(query)) return false;
      }
      if (s.deletedAt) {
        return false;
      }
      return true;
    });
  }

  return { filterSessions };
});
