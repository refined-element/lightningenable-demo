// Unit tests for parseBolt11Sats — the security-critical amount
// verifier in api/demo-refill.js. Run with `npm test` (uses Node's
// built-in node:test, no extra deps).
//
// Why these tests matter: parseBolt11Sats gates whether the demo
// refill flow will instruct OpenNode to pay an invoice. If the
// parser mis-reports the encoded amount, OpenNode happily pays
// whatever the bolt11 actually says — not what we asked for. The
// fragile case that motivated this coverage was the amount-less
// invoice `lnbc1pv...` where the `1` is the bech32 separator (not
// an amount); an earlier regex with an optional multiplier
// `[munp]?` mis-parsed it as amount=1, no multiplier → 100M sats
// (1 BTC). The current regex `^ln(bc|tb)(\d+)([munp])1` requires a
// multiplier AND a trailing bech32-separator `1` to make that
// failure mode impossible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBolt11Sats } from "../api/demo-refill.js";

test("micro multiplier — 200 sat invoice (the actual refill case)", () => {
  // `lnbc2u1...`: 2 × 0.000_001 BTC = 200 sats. This is what CoinOS
  // returns for the configured REFILL_SATS=200.
  assert.equal(parseBolt11Sats("lnbc2u1pv9xyzabc"), 200);
});

test("milli multiplier — 100_000 sats per unit", () => {
  assert.equal(parseBolt11Sats("lnbc1m1pv9xyz"), 100_000);
  assert.equal(parseBolt11Sats("lnbc5m1pv9xyz"), 500_000);
});

test("micro multiplier — 100 sats per unit", () => {
  assert.equal(parseBolt11Sats("lnbc1u1pv9xyz"), 100);
  assert.equal(parseBolt11Sats("lnbc500u1pv9xyz"), 50_000);
});

test("nano multiplier — divisible by 10 returns whole sats", () => {
  // 100n = 100 × 0.000_000_001 BTC = 100 × 0.1 sats = 10 sats
  assert.equal(parseBolt11Sats("lnbc100n1pv9xyz"), 10);
  // 2000n = 200 sats
  assert.equal(parseBolt11Sats("lnbc2000n1pv9xyz"), 200);
});

test("nano multiplier — non-multiple of 10 is rejected (no silent rounding)", () => {
  // 1n = 0.1 sats; we never round down to 0
  assert.equal(parseBolt11Sats("lnbc1n1pv9xyz"), null);
  // 15n = 1.5 sats; rounding would lose half a sat
  assert.equal(parseBolt11Sats("lnbc15n1pv9xyz"), null);
});

test("pico multiplier — divisible by 10_000 returns whole sats", () => {
  // 10_000p = 1 sat
  assert.equal(parseBolt11Sats("lnbc10000p1pv9xyz"), 1);
  // 2_000_000p = 200 sats
  assert.equal(parseBolt11Sats("lnbc2000000p1pv9xyz"), 200);
});

test("pico multiplier — non-multiple of 10_000 is rejected", () => {
  assert.equal(parseBolt11Sats("lnbc1p1pv9xyz"), null);
  assert.equal(parseBolt11Sats("lnbc9999p1pv9xyz"), null);
});

test("amount-less invoice (regex hardening regression case)", () => {
  // `lnbc1pv...` is a real shape — a 0-amount invoice where the `1`
  // is the bech32 separator, not an amount. The earlier regex
  // `^ln(bc|tb)(\d+)([munp]?)` matched this as amount=1, no
  // multiplier, and returned 100_000_000 (1 BTC). Catastrophic.
  // The required multiplier prevents the match.
  assert.equal(parseBolt11Sats("lnbc1pv9xyz"), null);
  assert.equal(parseBolt11Sats("lntb1pv9xyz"), null);
});

test("zero amount is rejected", () => {
  // amount=0 with any multiplier is still 0; reject so we don't
  // silently "succeed" on a malformed invoice.
  assert.equal(parseBolt11Sats("lnbc0u1pv9xyz"), null);
  assert.equal(parseBolt11Sats("lnbc0m1pv9xyz"), null);
});

test("testnet prefix (lntb) is accepted", () => {
  assert.equal(parseBolt11Sats("lntb2u1pv9xyz"), 200);
});

test("mainnet/testnet only — signet (lntbs) is not accepted", () => {
  // lntbs is signet; the current regex anchors to (bc|tb) only.
  // If signet support is ever needed, update the regex AND this test.
  // The `s` after `tb` falls into the multiplier slot, which isn't
  // a digit, so the match fails as a side effect.
  assert.equal(parseBolt11Sats("lntbs2u1pv9xyz"), null);
});

test("non-string inputs return null without throwing", () => {
  assert.equal(parseBolt11Sats(null), null);
  assert.equal(parseBolt11Sats(undefined), null);
  assert.equal(parseBolt11Sats(123), null);
  assert.equal(parseBolt11Sats({}), null);
  assert.equal(parseBolt11Sats([]), null);
});

test("uppercase invoice is normalized — BOLT-11 is case-insensitive", () => {
  // Real CoinOS invoices are lowercase but BOLT-11 is technically
  // case-insensitive, so a defensive lowercase normalize lets us
  // accept either form without behaving differently.
  assert.equal(parseBolt11Sats("LNBC2U1PV9XYZ"), 200);
});

test("missing prefix returns null", () => {
  assert.equal(parseBolt11Sats(""), null);
  assert.equal(parseBolt11Sats("bc2u1pv9xyz"), null);
  assert.equal(parseBolt11Sats("not-a-bolt11"), null);
});
