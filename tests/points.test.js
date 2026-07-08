"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeSessionPoints } = require("../points.js");

test("computeSessionPoints: awards the point value when the listener is a real student", () => {
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: 5 }), 5);
});

test("computeSessionPoints: awards zero when the listener is 'outside' or 'listening_only'", () => {
  assert.equal(computeSessionPoints({ listenerType: "outside", pointValue: 5 }), 0);
  assert.equal(computeSessionPoints({ listenerType: "listening_only", pointValue: 5 }), 0);
});

test("computeSessionPoints: treats a non-numeric or non-positive point value as zero", () => {
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: 0 }), 0);
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: -3 }), 0);
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: "abc" }), 0);
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: undefined }), 0);
});

test("computeSessionPoints: truncates a fractional point value to an integer", () => {
  assert.equal(computeSessionPoints({ listenerType: "student", pointValue: 5.9 }), 5);
});
