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
 *   37 min before the daily smoke test (12:07 UTC), so a freshly-
 *   refilled wallet is in place when the smoke validates the agent
 *   flow.
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
  // RFC 7235 §2.1: the authentication scheme name is case-insensitive
  // ("Bearer" / "bearer" / "BEARER" all mean the same scheme). The
  // configured GitHub Actions caller sends "Bearer " exactly so this
  // is unlikely to bite us in production, but tools used for manual
  // testing (curl with various plugins, Postman, IDE HTTP-clients)
  // sometimes normalize the scheme differently. A case-sensitive
  // check is a footgun: presented would be the empty string, leading
  // to a 401 that looks like a wrong-key failure when it's actually
  // a wrong-case scheme. Test the prefix case-insensitively, then
  // slice off whatever the caller actually wrote.
  const SCHEME = "Bearer ";
  const looksLikeBearer = auth.length >= SCHEME.length
    && auth.slice(0, SCHEME.length).toLowerCase() === SCHEME.toLowerCase();
  const presented = looksLikeBearer ? auth.slice(SCHEME.length) : "";
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

  // Defense-in-depth: the LNURL-pay callback URL is returned by the
  // metadata response we just received, so a compromised CoinOS (or
  // a MITM) could in principle hand back a callback pointing at an
  // attacker-controlled host. Verify BOTH the protocol and the host
  // of the callback before following it:
  //   - Protocol must be `https:` — a host-only check would accept
  //     `http://coinos.io/...` (or `ftp://`, `javascript:`, etc.),
  //     downgrading the subsequent invoice fetch to plaintext where
  //     a network attacker could swap the bolt11 we receive.
  //   - Host must match the hardcoded LIGHTNING_ADDRESS domain so
  //     we never follow a same-origin-spoofing redirect to a third
  //     party.
  // If CoinOS legitimately moves to a different domain in the future,
  // both checks fail closed and the operator updates the hardcoded
  // LIGHTNING_ADDRESS / domain string — preferable to silently
  // accepting either a protocol downgrade or a host change.
  let callbackHost;
  let callbackProtocol;
  try {
    const callbackParsed = new URL(lnurlpMeta.callback);
    callbackHost = callbackParsed.host;
    callbackProtocol = callbackParsed.protocol;
  } catch {
    return res.status(502).json({
      ok: false,
      error: `CoinOS LNURL-pay callback URL is malformed: "${String(lnurlpMeta.callback).slice(0, 100)}"`,
      trace,
    });
  }
  if (callbackProtocol !== "https:") {
    return res.status(502).json({
      ok: false,
      error: `CoinOS LNURL-pay callback protocol "${callbackProtocol}" is not https. Refusing to follow a non-https callback.`,
      trace,
    });
  }
  if (callbackHost !== domain) {
    return res.status(502).json({
      ok: false,
      error: `CoinOS LNURL-pay callback host "${callbackHost}" does not match the lightning-address domain "${domain}". Refusing to follow a cross-host callback.`,
      trace,
    });
  }
  log("callback_host_verified", { host: callbackHost, protocol: callbackProtocol });

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

  // Verify the invoice's encoded amount matches what we asked for.
  // A misbehaving (or malicious) LNURL endpoint could return an
  // invoice for a larger amount than the LNURL-pay request specified;
  // without this check, OpenNode would happily pay whatever the
  // invoice says. Parses the BOLT-11 amount prefix
  // (lnbc<amount><multiplier>): no multiplier = BTC, m=milli, u=micro,
  // n=nano, p=pico. We compare to REFILL_SATS exactly — over- or
  // under-payment both fail.
  const parsedSats = parseBolt11Sats(bolt11);
  if (parsedSats === null) {
    return res.status(502).json({
      ok: false,
      error: "Could not parse the amount from the BOLT-11 invoice returned by CoinOS.",
      trace,
    });
  }
  if (parsedSats !== REFILL_SATS) {
    return res.status(502).json({
      ok: false,
      error: `BOLT-11 invoice amount (${parsedSats} sat) does not match the requested refill amount (${REFILL_SATS} sat). Refusing to pay a mismatched invoice.`,
      trace,
    });
  }
  log("invoice_amount_verified", { sats: parsedSats });

  // Known limitation: we don't parse / validate the BOLT-11 expiry
  // tag here. CoinOS issues invoices with a default expiry (commonly
  // 600 seconds). OpenNode's withdrawal API submits asynchronously
  // — its synchronous response is "submitted, status=pending" and
  // the on-chain (or off-chain) settlement happens after the HTTP
  // call returns. If OpenNode happens to queue the withdrawal long
  // enough that the invoice expires before payment is attempted,
  // the settlement will fail asynchronously and we won't know from
  // this endpoint's response — the operator only learns about it
  // from OpenNode's dashboard (or by inspecting the refill's
  // failure to actually credit CoinOS).
  //
  // We intentionally accept this tradeoff because:
  //   1. The daily refill cron is the only caller, and 600s is more
  //      than enough headroom for OpenNode's normal queue latency
  //      (typically sub-minute).
  //   2. Adding expiry validation would require pulling in a
  //      BOLT-11 decoder (not just the prefix parser we already
  //      have) — significant code surface for a low-probability
  //      failure mode in a manually-recoverable system.
  //   3. The daily-smoke workflow exercises the demo flow 37 min
  //      AFTER this runs, and INSUFFICIENT_BALANCE on the smoke
  //      side surfaces a refill failure indirectly with one day's
  //      latency at most.
  // If demand ever shifts to faster recovery, the right fix is to
  // poll OpenNode's `GET /v2/withdrawal/{id}` for transition to
  // confirmed/failed and surface that asynchronously.

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
      // Look for OpenNode's "not enough balance" signal vs. an
      // auth/scope/etc failure. Detection logic is extracted into
      // `isInsufficientBalanceError` (see bottom of file) so the
      // regression cases that motivated tightening it (auth-failure
      // shapes that contain "insufficient" but aren't balance-related)
      // can be locked down by unit tests.
      const msg = (parsed?.message || text || "").toString();
      const isInsufficientBalance = isInsufficientBalanceError(r.status, msg);
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
      // Defense-in-depth: scrub credential-shaped data from any
      // echoed text before returning. OpenNode's documented error
      // shape is `{ message: "..." }` and we prefer that, but
      // `text.slice(...)` is the fallback when the response isn't
      // JSON. If OpenNode (or any intermediate proxy) ever echoed
      // back the Authorization header value — even in a transformed
      // form (URL-encoded, base64-wrapped, partially masked by a
      // proxy) — returning it in our JSON response would surface
      // the key to whatever called this endpoint.
      //
      // Scrub credential-shaped data from echoed OpenNode error
      // text. Implementation is extracted into `redactSensitive`
      // (see bottom of file) so the diagnostic-preservation
      // properties (UUIDs and SHA-256 hashes survive intact) can
      // be pinned down by unit tests.
      const rawDetails = parsed?.message ?? text.slice(0, 300);
      const safeDetails = redactSensitive(rawDetails, openNodeKey);
      return res.status(502).json({
        ok: false,
        error: `OpenNode withdrawal failed: HTTP ${r.status}`,
        details: safeDetails,
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

/**
 * Parses the amount encoded in a BOLT-11 invoice prefix.
 * Returns the amount in whole sats, or null if the invoice is
 * unparseable or has an unsupported multiplier resolution.
 *
 * BOLT-11 amount format: `lnbc<amount><multiplier>...`
 *   - `m` (milli):    amount × 0.001 BTC              (× 100_000     sats)
 *   - `u` (micro):    amount × 0.000_001 BTC          (× 100         sats)
 *   - `n` (nano):     amount × 0.000_000_001 BTC      (÷ 10          sats; fraction)
 *   - `p` (pico):     amount × 0.000_000_000_001 BTC  (÷ 10_000      sats; fraction)
 *
 * The BOLT-11 spec also defines a no-multiplier form (`lnbc<amount>1`
 * = whole BTC), but THIS PARSER REJECTS IT. Reasons:
 *   - The demo refill flow only ever asks for sub-BTC amounts
 *     (currently 200 sat), so accepting whole-BTC amounts would only
 *     ever happen via a misbehaving CoinOS response or a crafted
 *     attack — both of which we want to fail closed.
 *   - The no-multiplier regex is ambiguous against the bech32
 *     separator `1` (e.g. `lnbc1pv...` is an amount-LESS invoice,
 *     where the `1` is the separator). An earlier regex variant
 *     matched that shape as amount=1 / no-multiplier and returned
 *     100M sats (1 BTC) — catastrophic. Requiring a multiplier
 *     `[munp]` plus a literal `1` separator pins down the syntax.
 * If you ever need whole-BTC support, change the regex AND add
 * explicit tests for the bech32-separator confusion case.
 *
 * For REFILL_SATS=200, expected invoice prefix is `lnbc2u`. We
 * reject fractional results (nano/pico shapes whose amount isn't
 * a clean multiple) to avoid silently rounding.
 *
 * Mainnet (`lnbc`) and testnet (`lntb`) both supported; signet
 * (`lntbs`) currently isn't — change `^ln(bc|tb)` if needed.
 */
function parseBolt11Sats(bolt11) {
  if (typeof bolt11 !== "string") return null;
  // Required structure: ln{bc|tb} + digits (amount) + multiplier
  // (m/u/n/p) + literal "1" (bech32 separator). The required
  // multiplier rules out amount-less invoices like `lnbc1pv...`
  // where the `1` is the bech32 separator (not an amount) — the
  // earlier `[munp]?` (optional multiplier) regex would have
  // mis-parsed that as amount=1, no-multiplier, and returned a
  // bogus 100M sat (1 BTC) value.
  //
  // The required trailing "1" pins down the bech32 separator, so
  // we don't confuse a whole-BTC amount like `lnbc11p...` (which
  // is amount=1 BTC, with bech32 separator absent in this position
  // — actually it'd be `lnbc1...` with no multiplier, which we
  // explicitly do not support for the demo refill flow because
  // CoinOS will always issue with a multiplier for sub-BTC
  // amounts).
  const m = bolt11.toLowerCase().match(/^ln(bc|tb)(\d+)([munp])1/);
  if (!m) return null;
  // Defense-in-depth bound on the digit run. A crafted invoice like
  // `lnbc999999999999999m1...` would `parseInt` to a finite Number
  // (JS numbers are doubles, so parseInt happily returns values
  // above Number.MAX_SAFE_INTEGER as imprecise floats) and then the
  // `amount * 100_000` line for the milli multiplier would silently
  // produce an imprecise result. Today this isn't exploitable
  // because the caller strict-equality compares the result to
  // REFILL_SATS (currently 200), but adding an upper bound makes
  // the parser safer for any future caller that doesn't apply that
  // check. We reject any amount where the digit run is implausibly
  // long for a real invoice — the largest legitimate BOLT-11 amount
  // is 2_100_000_000_000_000 pico-BTC (21M BTC, the bitcoin supply
  // cap), which is 16 digits. We cap at 18 digits as a comfortable
  // ceiling.
  if (m[2].length > 18) return null;
  const amount = parseInt(m[2], 10);
  const mult = m[3];
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // After multiplier conversion, the result must still fit in a
  // safe-integer sat value. 21M BTC = 2.1e15 sats, well below
  // Number.MAX_SAFE_INTEGER (9.0e15), so a legitimate invoice can't
  // overflow — but a crafted one with a permitted multiplier and a
  // large pre-multiplier amount could. Belt and suspenders: cap the
  // final sat output at 100M sat (1 BTC). The demo only ever pays
  // 200 sat refills; anything approaching 1 BTC is, by definition,
  // not what we asked CoinOS for.
  const MAX_SATS = 100_000_000;
  const computed = (() => {
  // Conversion phrasings deliberately match the header docstring's
  // "÷ N sats" form so the two don't drift. (Earlier these were
  // "amount × 0.0001 sats" / "amount × 0.1 sats", which is the same
  // math but inverted phrasing and harder to reconcile against the
  // header at a glance.)
    switch (mult) {
      case "m": return amount * 100_000;
      case "u": return amount * 100;
      case "n":
        // nano: amount ÷ 10 sats; must be a multiple of 10 to yield whole sats
        if (amount % 10 !== 0) return null;
        return amount / 10;
      case "p":
        // pico: amount ÷ 10_000 sats; must be a multiple of 10_000 to yield whole sats
        if (amount % 10_000 !== 0) return null;
        return amount / 10_000;
      default:
        return null;
    }
  })();
  if (computed === null) return null;
  if (computed >= MAX_SATS) return null;
  return computed;
}

/**
 * Pure predicate: is THIS OpenNode error response an "insufficient
 * balance" condition we should silently skip (vs. a real failure
 * that must alert)? Extracted from the inline handler logic so unit
 * tests can pin down the regression cases that motivated the
 * tightening — specifically that "Insufficient permissions" /
 * "Insufficient API key scope" (auth/scope failures) do NOT match,
 * even though they contain the word "insufficient."
 *
 * Returns true ONLY when:
 *   1. HTTP status is 400 or 402 (OpenNode's typical "balance"
 *      response codes), AND
 *   2. The error message explicitly pairs a quantity word with
 *      "balance" or "funds".
 *
 * @param {number} httpStatus
 * @param {string} message
 * @returns {boolean}
 */
function isInsufficientBalanceError(httpStatus, message) {
  if (httpStatus !== 400 && httpStatus !== 402) return false;
  const msg = (message ?? "").toString();
  // Each branch requires balance/funds to appear within a tight
  // local window of the quantity word — no .* wildcards that could
  // span clauses. The third branch in particular used to be
  // `/(balance|funds)[^a-z0-9]+.*(too[^a-z0-9]+)?low/i`, where the
  // greedy `.*` let it match "Account balance is high but
  // permissions too low" — an auth failure with the word "balance"
  // anywhere earlier in the message. The replacement requires
  // balance/funds and "low" to be separated only by short connector
  // words (`is`, `too`, `very`, `quite`, `running`, etc.) so the
  // two have to be in the same clause.
  return (
    /insufficient[^a-z0-9]+(available[^a-z0-9]+)?(balance|funds)/i.test(msg) ||
    /not[^a-z0-9]+enough[^a-z0-9]+(balance|funds)/i.test(msg) ||
    /(balance|funds)(\s+(is|are|too|very|quite|running|getting)){0,3}\s+(too\s+)?low/i.test(msg) ||
    /low[^a-z0-9]+(balance|funds)/i.test(msg) ||
    /no[^a-z0-9]+funds/i.test(msg)
  );
}

/**
 * Pure helper: scrub credential-shaped data from an echoed error
 * detail string while preserving legitimate opaque identifiers
 * (UUIDs, withdrawal IDs, payment hashes) so the operator can
 * still trace the failed request in OpenNode's dashboard.
 *
 * Three layers:
 *   1. Pre-extract UUIDs (canonical 8-4-4-4-12 hyphenated form).
 *      These NEVER get redacted, regardless of other rules.
 *   2. Exact-match scrub of `exactKey` (the configured OpenNode
 *      API key — the common case if anything echoed it back).
 *   3. Length-gated opaque-token scrub at 65+ chars. Above
 *      UUIDs (36), above SHA-256 hashes (64), at-or-above
 *      realistic API key lengths.
 *
 * @param {string} text — the detail string to sanitize
 * @param {string} exactKey — the configured API key to scrub
 * @returns {string}
 */
function redactSensitive(text, exactKey) {
  if (typeof text !== "string") return text;
  const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
  // Per-call random nonce for the UUID sentinel. The previous
  // version used a fixed `\x00UUID<n>\x00` token — if some
  // adversarial input contained that literal substring (a proxy
  // echo, a test fixture, an attacker payload), the final
  // restoration step would replace it with `uuidMatches[n]`, which
  // is `undefined` when no UUIDs were extracted at that index,
  // producing the literal string "undefined" in the output. The
  // random nonce makes pre-existing collisions vanishingly unlikely:
  // 128 bits of entropy means an attacker would need ~2^64 attempts
  // to land one, and they'd need to do it BEFORE the function ran
  // (since the nonce is regenerated each call). The nonce is plain
  // hex so it can't accidentally contain regex metacharacters.
  const nonce = crypto.randomBytes(16).toString("hex");
  const uuidMatches = [];
  const withoutUuids = text.replace(UUID_RE, (m) => {
    uuidMatches.push(m);
    return `\x00${nonce}${uuidMatches.length - 1}\x00`;
  });
  let redacted = withoutUuids;
  if (exactKey) {
    redacted = redacted.split(exactKey).join("[redacted]");
  }
  redacted = redacted.replace(/[A-Za-z0-9_-]{65,}/g, "[redacted]");
  // Build a regex that only matches the per-call nonce.
  const restoreRe = new RegExp(`\\x00${nonce}(\\d+)\\x00`, "g");
  return redacted.replace(restoreRe, (_, i) => uuidMatches[Number(i)]);
}

// Named exports for unit tests. `default` is the HTTP handler — Vercel
// looks for it specifically — and we keep these helpers private to
// the runtime path by convention, but exposing them as named exports
// lets the test file import them without duplicating the
// implementation.
export { parseBolt11Sats, isInsufficientBalanceError, redactSensitive };
