/**
 * POST /api/demo-refill
 *
 * Moves a small fixed amount of sats from the demo merchant's OpenNode
 * balance (which accumulates from completed L402 demo runs) BACK to
 * the demo's CoinOS NWC wallet (which pays each new demo run). Closes
 * the loop so the demo stays funded without manual intervention.
 *
 * Hardcoded destination + amount — even if the admin key is leaked,
 * the endpoint can only ever pay:
 *   - the one configured CoinOS Lightning address (`LIGHTNING_ADDRESS`)
 *   - the one configured refill amount (`REFILL_SATS`)
 * A thief can call this repeatedly, but every successful call moves
 * sats from one of the operator's own accounts to another of the
 * operator's own accounts — not into an attacker's wallet.
 *
 * The actual cap on damage is set at the wallet layer:
 *   - OpenNode side: the `OPENNODE_WITHDRAWAL_API_KEY` should have a
 *     daily/monthly withdrawal limit if OpenNode supports it
 *   - CoinOS side: the receiving wallet is a passive payee, no risk
 *
 * Auth:
 *   `Authorization: Bearer <DEMO_REFILL_ADMIN_KEY>` required. The
 *   key is shared between Vercel env (here) and a GitHub Actions
 *   secret (caller). Generate with `openssl rand -hex 32`.
 *
 * Caller:
 *   .github/workflows/daily-refill.yml fires this at 11:30 UTC daily,
 *   30 min before the daily smoke test runs, so a freshly-refilled
 *   wallet is in place when the smoke validates the agent flow.
 */

import crypto from "node:crypto";

// Hardcoded destination + amount so an attacker with the admin key
// can't redirect funds elsewhere or inflate the per-call drain.
const LIGHTNING_ADDRESS = "sole86@coinos.io";
const REFILL_SATS = 200;

// OpenNode API base is env-overridable for dev testing but ALLOWLISTED —
// `OPENNODE_API_BASE_URL=https://evil.example.com` would not pass this
// check, preserving the "destination is hardcoded" guarantee in the
// face of operator env-var fat-finger or compromise.
const OPENNODE_API_BASE_ALLOWED = new Set([
  "https://api.opennode.com",     // production
  "https://dev-api.opennode.com", // dev / staging
]);

// Per-fetch timeouts. Without these, a hung upstream (CoinOS LNURL
// or OpenNode API stall) would burn the Vercel function's full
// maxDuration on a single call, returning a Vercel-plaintext kill
// instead of clean JSON.
const COINOS_FETCH_TIMEOUT_MS = 10_000;
const OPENNODE_FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // ── 1. Auth ──────────────────────────────────────────────────────────
  const adminKey = process.env.DEMO_REFILL_ADMIN_KEY;
  if (!adminKey) {
    return res.status(500).json({
      ok: false,
      error: "Server misconfig: DEMO_REFILL_ADMIN_KEY is not set on this Vercel project.",
    });
  }
  const auth = req.headers["authorization"] || "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  // Constant-time compare. JS string `.length` reports UTF-16 code
  // units, NOT bytes — for a non-ASCII admin key, that would
  // mis-classify equal-length-as-bytes strings as unequal-length.
  // Convert both sides to Buffers up front and use the byte-level
  // length for the pre-check + timingSafeEqual for the constant-
  // time bit-level comparison.
  const presentedBuf = Buffer.from(presented, "utf8");
  const adminKeyBuf = Buffer.from(adminKey, "utf8");
  if (presentedBuf.length === 0 || presentedBuf.length !== adminKeyBuf.length) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (!crypto.timingSafeEqual(presentedBuf, adminKeyBuf)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // ── 2. OpenNode withdrawal key + API base allowlist ─────────────────
  const openNodeKey = process.env.OPENNODE_WITHDRAWAL_API_KEY;
  if (!openNodeKey) {
    return res.status(500).json({
      ok: false,
      error: "Server misconfig: OPENNODE_WITHDRAWAL_API_KEY is not set on this Vercel project. " +
             "Generate an OpenNode API key with Withdrawals scope and add it to Vercel env vars.",
    });
  }
  const openNodeBase = process.env.OPENNODE_API_BASE_URL || "https://api.opennode.com";
  if (!OPENNODE_API_BASE_ALLOWED.has(openNodeBase)) {
    return res.status(500).json({
      ok: false,
      error: `Server misconfig: OPENNODE_API_BASE_URL "${openNodeBase}" is not in the allowlist. ` +
             "Valid values are https://api.opennode.com (default) or https://dev-api.opennode.com.",
    });
  }

  const trace = [];
  const t0 = Date.now();
  const log = (step, extras = {}) => trace.push({ t: Date.now() - t0, step, ...extras });

  // ── 3. Resolve the LNURL-pay endpoint for the CoinOS address ─────────
  // Lightning Address format `user@domain` resolves to
  // `https://<domain>/.well-known/lnurlp/<user>`. We hardcode the
  // value so this resolution can never be redirected to a third
  // party even if the LIGHTNING_ADDRESS string somehow changed.
  const [localPart, domain] = LIGHTNING_ADDRESS.split("@");
  if (!localPart || !domain) {
    return res.status(500).json({
      ok: false,
      error: `Hardcoded LIGHTNING_ADDRESS "${LIGHTNING_ADDRESS}" is malformed.`,
    });
  }
  const lnurlpUrl = `https://${domain}/.well-known/lnurlp/${localPart}`;
  log("lnurlp_resolve", { lnurlpUrl });

  let lnurlpMeta;
  try {
    const r = await fetchWithTimeout(lnurlpUrl, {
      headers: { Accept: "application/json", "User-Agent": "LightningEnable-Demo-Refill/1.0" },
    }, COINOS_FETCH_TIMEOUT_MS);
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `CoinOS LNURL-pay metadata fetch failed: HTTP ${r.status}`,
        trace,
      });
    }
    lnurlpMeta = await r.json();
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `CoinOS LNURL-pay metadata fetch failed: ${err?.message || err}`,
      trace,
    });
  }
  log("lnurlp_meta", {
    tag: lnurlpMeta?.tag,
    minSendable: lnurlpMeta?.minSendable,
    maxSendable: lnurlpMeta?.maxSendable,
  });

  if (lnurlpMeta?.tag !== "payRequest" || !lnurlpMeta?.callback) {
    return res.status(502).json({
      ok: false,
      error: "CoinOS LNURL-pay response did not look like a payRequest (missing tag/callback).",
      trace,
    });
  }

  // LNURL-pay expects amount in millisats. Validate it's within the
  // wallet's declared range to avoid the callback returning an error
  // we'd then have to translate.
  const amountMsats = REFILL_SATS * 1000;
  if (typeof lnurlpMeta.minSendable === "number" && amountMsats < lnurlpMeta.minSendable) {
    return res.status(502).json({
      ok: false,
      error: `Refill amount ${REFILL_SATS} sat is below CoinOS minSendable ${lnurlpMeta.minSendable / 1000} sat.`,
      trace,
    });
  }
  if (typeof lnurlpMeta.maxSendable === "number" && amountMsats > lnurlpMeta.maxSendable) {
    return res.status(502).json({
      ok: false,
      error: `Refill amount ${REFILL_SATS} sat exceeds CoinOS maxSendable ${lnurlpMeta.maxSendable / 1000} sat.`,
      trace,
    });
  }

  // ── 4. Get a fresh invoice for the configured amount ────────────────
  const callbackUrl = new URL(lnurlpMeta.callback);
  callbackUrl.searchParams.set("amount", String(amountMsats));
  let invoiceResponse;
  try {
    const r = await fetchWithTimeout(callbackUrl.toString(), {
      headers: { Accept: "application/json", "User-Agent": "LightningEnable-Demo-Refill/1.0" },
    }, COINOS_FETCH_TIMEOUT_MS);
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `CoinOS LNURL-pay callback failed: HTTP ${r.status}`,
        trace,
      });
    }
    invoiceResponse = await r.json();
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `CoinOS LNURL-pay callback failed: ${err?.message || err}`,
      trace,
    });
  }
  const bolt11 = invoiceResponse?.pr;
  if (!bolt11 || typeof bolt11 !== "string") {
    return res.status(502).json({
      ok: false,
      error: `CoinOS LNURL-pay callback returned no invoice (pr) field.`,
      details: JSON.stringify(invoiceResponse).slice(0, 300),
      trace,
    });
  }
  log("invoice_received", { bolt11Prefix: bolt11.slice(0, 16) + "…" });

  // ── 5. Ask OpenNode to pay that invoice ──────────────────────────────
  // OpenNode's withdrawal API: POST /v2/withdrawals with the bolt11
  // as the `address` field. Auth via raw API key in the
  // Authorization header (no "Bearer" prefix per OpenNode docs).
  //
  // GRACEFUL SKIP on insufficient balance: the OpenNode merchant
  // account is only refilled by demo runs (each "Run the agent"
  // click pays X sats → those sats arrive at OpenNode). After an
  // idle period the OpenNode balance can drop to 0, at which
  // point a refill call would fail. That's not an alertable
  // error — it's the system at rest with nothing to move. Detect
  // OpenNode's "insufficient balance" response and return
  // skipped:true with HTTP 200 so the workflow doesn't open an
  // issue / send an email for a benign condition.
  let withdrawalResponse;
  try {
    const r = await fetchWithTimeout(`${openNodeBase}/v2/withdrawals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": openNodeKey,
        "Accept": "application/json",
        "User-Agent": "LightningEnable-Demo-Refill/1.0",
      },
      body: JSON.stringify({ type: "ln", address: bolt11 }),
    }, OPENNODE_FETCH_TIMEOUT_MS);
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (!r.ok) {
      // Look for OpenNode's "not enough balance" signal. They've
      // historically used messages like "Insufficient available
      // balance" / "Not enough balance" — case-insensitive substring
      // match catches the common shapes without locking us to one
      // exact spelling.
      const msg = (parsed?.message || text || "").toString();
      const isInsufficientBalance = /insufficient/i.test(msg)
        && /balance/i.test(msg);
      if (isInsufficientBalance) {
        log("openNode_insufficient_balance");
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: "OpenNode balance too low to cover refill — no action taken. " +
                  "This is normal during idle periods (no demo runs means no sats " +
                  "have accumulated in OpenNode to move). The next refill will retry.",
          refillSats: REFILL_SATS,
          destination: LIGHTNING_ADDRESS,
          trace,
        });
      }
      return res.status(502).json({
        ok: false,
        error: `OpenNode withdrawal failed: HTTP ${r.status}`,
        details: parsed?.message || text.slice(0, 300),
        trace,
      });
    }
    withdrawalResponse = parsed;
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `OpenNode withdrawal request failed: ${err?.message || err}`,
      trace,
    });
  }
  log("withdrawal_submitted");

  // OpenNode's response shape: { data: { id, amount, fee, status, ... } }
  // `status` is typically "pending" initially; it transitions to
  // "confirmed" or "failed" asynchronously. We trust the synchronous
  // "withdrawal submitted" result and let CoinOS handle settlement —
  // polling adds latency without much value.
  const data = withdrawalResponse?.data ?? {};
  return res.status(200).json({
    ok: true,
    refillSats: REFILL_SATS,
    destination: LIGHTNING_ADDRESS,
    withdrawal: {
      id: data.id ?? null,
      status: data.status ?? "submitted",
      amount: data.amount ?? null,
      fee: data.fee ?? null,
    },
    trace,
  });
}
