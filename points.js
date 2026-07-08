// ═══════════════════════════════════════════════════════════════
// Ta'ahud — Points calculation
// Pure, dependency-free logic shared by the check-in page (app.js)
// and Node tests. Points are only ever awarded to a real student
// listener; "outside" and "listening_only" sessions award nothing.
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

  function computeSessionPoints(input) {
    const listenerType = input && input.listenerType;
    if (listenerType !== "student") return 0;
    const value = Number(input.pointValue);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.trunc(value);
  }

  return { computeSessionPoints };
});
