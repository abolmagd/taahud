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
      if (f.from && new Date(s.createdAt) < new Date(f.from)) {
        return false;
      }
      if (f.to && new Date(s.createdAt) >= new Date(f.to)) {
        return false;
      }
      return true;
    });
  }

  return { filterSessions };
});
