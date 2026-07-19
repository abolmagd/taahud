// ═══════════════════════════════════════════════════════════════
// Ta'ahud — resilient student session submission helpers
// Pure, dependency-free logic shared by the browser and Node tests.
// ═══════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TaahudSessionSubmit = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function errorText(error) {
    if (!error) return "";
    return [error.message, error.details, error.hint, error.code]
      .filter(Boolean)
      .join(" ");
  }

  function diagnosticLabel(error) {
    const code = error && error.code ? String(error.code) : "NO_CODE";
    const message = error && error.message ? String(error.message) : "unknown_error";
    return code + ": " + message;
  }

  function isTransientError(error) {
    const message = errorText(error).toLowerCase();
    const httpStatus = Number(error && (error.status || error.statusCode));
    return (
      httpStatus === 408 ||
      httpStatus === 429 ||
      httpStatus >= 500 ||
      message.includes("failed to fetch") ||
      message.includes("networkerror") ||
      message.includes("network error") ||
      message.includes("load failed") ||
      message.includes("timeout") ||
      message.includes("connection reset")
    );
  }

  async function callWithTransientRetry(request, retries) {
    const retryCount = Number.isInteger(retries) ? Math.max(0, retries) : 1;
    let result;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      result = await request();
      if (!result || !result.error || !isTransientError(result.error) || attempt === retryCount) {
        return result;
      }
    }
    return result;
  }

  function createRequestId(cryptoApi) {
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
      return cryptoApi.randomUUID();
    }
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
      throw new Error("secure_random_unavailable");
    }
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return (
      hex.slice(0, 4).join("") + "-" +
      hex.slice(4, 6).join("") + "-" +
      hex.slice(6, 8).join("") + "-" +
      hex.slice(8, 10).join("") + "-" +
      hex.slice(10, 16).join("")
    );
  }

  return { errorText, diagnosticLabel, isTransientError, callWithTransientRetry, createRequestId };
});
