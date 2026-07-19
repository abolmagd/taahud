"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  errorText,
  diagnosticLabel,
  isTransientError,
  callWithTransientRetry,
  createRequestId,
} = require("../session-submit.js");

test("errorText includes Supabase details, hint, and code", () => {
  assert.equal(
    errorText({ message: "request failed", details: "network error", hint: "retry", code: "PGRST000" }),
    "request failed network error retry PGRST000"
  );
});

test("diagnosticLabel exposes the server code needed to diagnose an unknown save failure", () => {
  assert.equal(diagnosticLabel({ code: "42501", message: "permission denied" }), "42501: permission denied");
  assert.equal(diagnosticLabel(null), "NO_CODE: unknown_error");
});

test("isTransientError recognizes network and server failures but not validation errors", () => {
  assert.equal(isTransientError({ message: "TypeError: Failed to fetch" }), true);
  assert.equal(isTransientError({ message: "Service unavailable", status: 503 }), true);
  assert.equal(isTransientError({ message: "invalid_pages", code: "P0001" }), false);
});

test("callWithTransientRetry retries one network failure", async () => {
  let calls = 0;
  const result = await callWithTransientRetry(async () => {
    calls += 1;
    return calls === 1
      ? { data: null, error: { message: "Failed to fetch" } }
      : { data: { id: "saved" }, error: null };
  }, 1);
  assert.equal(calls, 2);
  assert.deepEqual(result, { data: { id: "saved" }, error: null });
});

test("callWithTransientRetry does not retry a database validation error", async () => {
  let calls = 0;
  const result = await callWithTransientRetry(async () => {
    calls += 1;
    return { data: null, error: { message: "invalid_pages", code: "P0001" } };
  }, 1);
  assert.equal(calls, 1);
  assert.equal(result.error.message, "invalid_pages");
});

test("createRequestId uses randomUUID when available and has a UUID fallback", () => {
  assert.equal(createRequestId({ randomUUID: () => "known-id" }), "known-id");
  const id = createRequestId({ getRandomValues: (bytes) => bytes.fill(7) });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
