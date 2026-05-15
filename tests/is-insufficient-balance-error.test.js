// Unit tests for isInsufficientBalanceError — the predicate that
// decides whether an OpenNode 4xx withdrawal response is a benign
// "skip, no funds to move yet" condition vs. a real failure that
// must alert. Run with `npm test`.
//
// Why this matters (the regression that motivated the tightening):
// the previous loose regex `/insufficient/i` matched OpenNode's
// auth-failure messages like "Insufficient permissions" and
// "Insufficient API key scope" — both of which mean the
// `OPENNODE_WITHDRAWAL_API_KEY` is revoked, wrong, or missing the
// Withdrawals scope. The workflow then treated those as success
// (skipped:true with HTTP 200) and never opened an alert issue,
// silently masking a real configuration failure. The tightened
// predicate requires the words "balance" or "funds" to appear with
// a quantity word, so auth-shape "Insufficient X" messages no
// longer slip through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isInsufficientBalanceError } from "../api/demo-refill.js";

// ── Should NOT match (auth/scope/config failures — must alert) ─────

test("does NOT match 'Insufficient permissions' (auth regression case)", () => {
  // This was the original Copilot finding: the loose regex
  // would silently classify a revoked-key auth failure as a
  // "skip" and the operator would never get notified.
  assert.equal(isInsufficientBalanceError(400, "Insufficient permissions"), false);
});

test("does NOT match 'Insufficient API key scope' (auth scope regression case)", () => {
  assert.equal(isInsufficientBalanceError(400, "Insufficient API key scope"), false);
});

test("does NOT match 'balance is high but permissions too low' (round-8 greedy-wildcard regression)", () => {
  // Round-8 finding: the third branch's greedy .* used to let the
  // regex match this message — "balance" appeared early, then
  // "too low" appeared later in an unrelated clause. The tightened
  // version requires balance/funds and "low" to be in the same
  // clause (separated only by short connector words: is/are/too/
  // very/quite/running/getting).
  assert.equal(isInsufficientBalanceError(400, "Account balance is high but permissions too low"), false);
});

test("does NOT match 'balance is fine but token scope too low' (round-8 regression)", () => {
  assert.equal(isInsufficientBalanceError(400, "Wallet balance is fine but token scope too low"), false);
});

test("does NOT match 'funds available but rate limit too low' (round-8 regression)", () => {
  assert.equal(isInsufficientBalanceError(400, "Funds available but rate limit too low"), false);
});

test("does NOT match 'Insufficient privileges'", () => {
  assert.equal(isInsufficientBalanceError(400, "Insufficient privileges"), false);
});

test("does NOT match 'Not enough characters in API key'", () => {
  // Adversarial: includes "Not enough" but not paired with balance/funds.
  assert.equal(isInsufficientBalanceError(400, "Not enough characters in API key"), false);
});

test("does NOT match generic 'Bad request'", () => {
  assert.equal(isInsufficientBalanceError(400, "Bad request"), false);
});

test("does NOT match on HTTP 500 even with balance-shaped message", () => {
  // 5xx is always an alert-worthy condition; the predicate only
  // recognizes 400/402.
  assert.equal(isInsufficientBalanceError(500, "Insufficient balance"), false);
});

test("does NOT match on HTTP 401 even with balance-shaped message", () => {
  assert.equal(isInsufficientBalanceError(401, "Insufficient balance"), false);
});

test("does NOT match on HTTP 200 (would be weird but defensive)", () => {
  assert.equal(isInsufficientBalanceError(200, "Insufficient balance"), false);
});

// ── Should MATCH (real balance shortage — silently skip) ──────────

test("matches 'Insufficient balance' (canonical)", () => {
  assert.equal(isInsufficientBalanceError(400, "Insufficient balance"), true);
});

test("matches 'Insufficient available balance' (OpenNode historical)", () => {
  assert.equal(isInsufficientBalanceError(400, "Insufficient available balance"), true);
});

test("matches 'Insufficient funds'", () => {
  assert.equal(isInsufficientBalanceError(400, "Insufficient funds"), true);
});

test("matches 'Not enough balance'", () => {
  assert.equal(isInsufficientBalanceError(400, "Not enough balance"), true);
});

test("matches 'Not enough funds'", () => {
  assert.equal(isInsufficientBalanceError(400, "Not enough funds"), true);
});

test("matches 'Account balance too low'", () => {
  assert.equal(isInsufficientBalanceError(400, "Account balance too low"), true);
});

test("matches 'Balance is low'", () => {
  assert.equal(isInsufficientBalanceError(400, "Balance is low"), true);
});

test("matches 'Low balance'", () => {
  assert.equal(isInsufficientBalanceError(400, "Low balance"), true);
});

test("matches 'No funds available'", () => {
  assert.equal(isInsufficientBalanceError(400, "No funds available"), true);
});

test("matches HTTP 402 (Payment Required) variant", () => {
  // OpenNode has historically used 402 for some balance responses.
  assert.equal(isInsufficientBalanceError(402, "Insufficient balance"), true);
});

test("matches case-insensitively", () => {
  assert.equal(isInsufficientBalanceError(400, "INSUFFICIENT BALANCE"), true);
  assert.equal(isInsufficientBalanceError(400, "insufficient available balance"), true);
});

test("handles null/undefined message defensively", () => {
  assert.equal(isInsufficientBalanceError(400, null), false);
  assert.equal(isInsufficientBalanceError(400, undefined), false);
  assert.equal(isInsufficientBalanceError(400, ""), false);
});
