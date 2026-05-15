// Unit tests for redactSensitive — the helper that scrubs
// credential-shaped substrings from echoed OpenNode error details
// while preserving legitimate opaque identifiers (UUIDs, payment
// hashes) so the operator can still trace the failed request.
// Run with `npm test`.
//
// Why these tests matter: the previous version had a generic
// `[A-Za-z0-9_-]{32,}` redaction pass that also stripped UUIDs (36
// chars) and SHA-256 hashes (64 chars). When OpenNode includes a
// withdrawal id in an error message, the operator's tracking issue
// would show `[redacted]` instead of the actual id needed to look
// the request up in OpenNode's dashboard. Round-7 raised the
// length threshold to 65+ AND added a UUID-shape allowlist so
// canonical 8-4-4-4-12 hyphenated UUIDs are NEVER redacted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSensitive } from "../api/demo-refill.js";

// ── Diagnostic identifiers — must SURVIVE redaction ───────────────

test("preserves canonical UUID (36 chars, 8-4-4-4-12 hyphenated)", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const out = redactSensitive(`Withdrawal ${uuid} failed`, "fake-key");
  assert.match(out, new RegExp(uuid));
  assert.ok(!out.includes("[redacted]"), "UUID-only text should not redact anything");
});

test("preserves SHA-256 payment hash (64 hex chars, no hyphens)", () => {
  // Note: 64 chars is below the 65-char threshold, so this passes
  // by the threshold alone. If we ever bump the threshold below 64,
  // this test will catch the regression.
  const hash = "a".repeat(64);
  const out = redactSensitive(`payment_hash=${hash}`, "fake-key");
  assert.match(out, new RegExp(hash));
  assert.ok(!out.includes("[redacted]"));
});

test("preserves OpenNode-style withdrawal ID (UUID format)", () => {
  // Real OpenNode withdrawal IDs are UUIDs.
  const wid = "abcdef12-3456-7890-abcd-ef1234567890";
  const out = redactSensitive(`Withdrawal ${wid} rejected`, "fake-key");
  assert.match(out, new RegExp(wid));
});

test("preserves a legit human-readable error verbatim", () => {
  const msg = "Insufficient available balance";
  assert.equal(redactSensitive(msg, "fake-key"), msg);
});

// ── Credentials — must be REDACTED ─────────────────────────────────

test("redacts the exact configured API key", () => {
  const key = "fixture-opennode-api-key-12345";
  const out = redactSensitive(`Auth failed with ${key}`, key);
  assert.ok(out.includes("[redacted]"));
  assert.ok(!out.includes(key));
});

test("redacts a 65+-char opaque token even if not the configured key", () => {
  // Defense in depth: if a proxy ever inserts a different long
  // opaque value (re-encoded key, intermediate token), it still
  // gets scrubbed.
  const longOpaque = "x".repeat(70);
  const out = redactSensitive(`echo: ${longOpaque}`, "different-fake-key");
  assert.ok(out.includes("[redacted]"));
  assert.ok(!out.includes(longOpaque));
});

test("redacts the exact key even when it includes special characters", () => {
  // OpenNode keys typically use [A-Za-z0-9] but be defensive.
  const key = "Bearer_dummy-test-key_XYZ";
  const out = redactSensitive(`got header value ${key}`, key);
  assert.ok(out.includes("[redacted]"));
});

// ── Mixed: identifiers AND credentials in same message ────────────

test("redacts the key but preserves UUIDs in a mixed message", () => {
  // The realistic alert scenario: OpenNode error includes both a
  // withdrawal id (for tracing) and somehow echoes the auth header
  // (the regression case we're defending against). The id stays;
  // the key is scrubbed.
  const key = "fixture-opennode-api-key-aaaaaaaaaaaaaaaa";
  const uuid = "11111111-2222-3333-4444-555555555555";
  const msg = `Withdrawal ${uuid} failed with auth ${key}`;
  const out = redactSensitive(msg, key);
  assert.match(out, new RegExp(uuid),
    "UUID must survive even when other content is being redacted");
  assert.ok(!out.includes(key),
    "the exact key must not leak through");
  assert.ok(out.includes("[redacted]"));
});

test("preserves multiple UUIDs in the same message", () => {
  const u1 = "11111111-2222-3333-4444-555555555555";
  const u2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const out = redactSensitive(`first=${u1} second=${u2}`, "fake-key");
  assert.match(out, new RegExp(u1));
  assert.match(out, new RegExp(u2));
});

// ── Defensive non-string input ────────────────────────────────────

test("returns non-string input unchanged", () => {
  assert.equal(redactSensitive(null, "key"), null);
  assert.equal(redactSensitive(undefined, "key"), undefined);
  assert.deepEqual(redactSensitive({ foo: "bar" }, "key"), { foo: "bar" });
});

test("handles empty exactKey gracefully (skips exact-match layer)", () => {
  const out = redactSensitive("some normal error message", "");
  assert.equal(out, "some normal error message");
});

test("handles missing exactKey (undefined) gracefully", () => {
  const out = redactSensitive("some normal error message", undefined);
  assert.equal(out, "some normal error message");
});

// ── Pathological inputs ───────────────────────────────────────────

test("does not strip a 64-char hex string (at the threshold boundary)", () => {
  // 64 chars is the SHA-256 length; threshold is 65+, so 64 survives.
  const hex64 = "f".repeat(64);
  const out = redactSensitive(`hash=${hex64}`, "key");
  assert.match(out, new RegExp(hex64));
});

test("input containing a literal sentinel-shaped substring does NOT produce 'undefined'", () => {
  // Round-8 finding: the previous implementation used the fixed
  // sentinel `\x00UUID<n>\x00` to round-trip UUIDs through the
  // redaction passes. If the input ever contained that literal
  // substring (proxy echo, attacker-crafted error message, test
  // fixture), the final restoration step would replace it with
  // `uuidMatches[n]`, which is `undefined` when no UUIDs were
  // extracted at that index — leaking the string "undefined" into
  // the output. The round-8 fix uses a per-call random nonce so
  // pre-existing collisions are vanishingly unlikely.
  //
  // The new sentinel embeds 128 bits of entropy, regenerated each
  // call, so we can't predict it ahead of time. We instead verify
  // the failure-mode symptom: no occurrence of the literal string
  // "undefined" in the output, given an adversarial input.
  const adversarial = "User said: \x00UUID0\x00 and also \x00UUID5\x00";
  const out = redactSensitive(adversarial, "fake-key");
  assert.ok(!out.includes("undefined"),
    "input that contains the OLD fixed sentinel must not produce 'undefined' in the output");
});

test("redacts a 65-char run (one above threshold)", () => {
  const blob65 = "z".repeat(65);
  const out = redactSensitive(`blob=${blob65}`, "different-key");
  assert.ok(out.includes("[redacted]"));
  assert.ok(!out.includes(blob65));
});
