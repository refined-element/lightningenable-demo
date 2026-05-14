/**
 * Agent function: POST /api/run-agent
 *
 * The visitor presses "Run the agent" on the landing page. This function acts
 * as an autonomous L402 buyer:
 *
 *   1. Calls our own merchant endpoint (/api/premium/weather or /btc-price)
 *   2. Receives 402 + Lightning invoice + macaroon
 *   3. Pays the invoice from the demo's funded NWC wallet
 *   4. Extracts the preimage from the wallet response
 *   5. Retries the same endpoint with Authorization: L402 macaroon:preimage
 *   6. Returns the full trace (timings per step, amounts, final data) to
 *      the frontend so the visitor sees an agentic Lightning payment happen
 *      end-to-end in ~1-2 seconds.
 *
 * This is the production-shape pattern an AI agent uses to buy from any
 * L402-enabled API on the open web.
 *
 * Body shape:
 *   { endpoint: "weather", city: "Miami" }
 *   { endpoint: "btc-price", currency: "USD" }
 *
 * Response shape:
 *   {
 *     ok: true,
 *     trace: [
 *       { step, label, durationMs, ... extra }
 *     ],
 *     final: { ... the 200 response body from the merchant endpoint }
 *   }
 *
 * The frontend renders `trace` as the timeline animation and `final` as the
 * "the agent bought this" result card.
 */

import { NwcWallet, findL402Challenge } from "l402-requests";

const SUPPORTED_ENDPOINTS = new Set(["weather", "btc-price"]);
const MAX_SATS_PER_REQUEST = 25; // sanity ceiling — way above 1-sat demo prices

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Parse body. Vercel auto-parses application/json into req.body.
  const body = req.body || {};
  const endpoint = String(body.endpoint || "").trim();
  if (!SUPPORTED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({
      ok: false,
      error: `Unknown endpoint "${endpoint}". Expected one of: ${[...SUPPORTED_ENDPOINTS].join(", ")}`,
    });
  }

  const nwcUrl = process.env.DEMO_AGENT_NWC_URL;
  if (!nwcUrl) {
    return res.status(500).json({
      ok: false,
      error:
        "Demo agent wallet is not configured. Set DEMO_AGENT_NWC_URL in Vercel project settings to a funded NWC connection (e.g. coinos.io).",
    });
  }

  // Build the target URL. Same host as ourselves so /api/premium/* resolves
  // to the merchant function next door.
  const origin = inferOriginFromRequest(req);
  const targetUrl = buildTargetUrl(origin, endpoint, body);

  const trace = [];
  const startedAt = Date.now();

  // ── Step 1: hit the endpoint with no credential, expect 402 ──────────────
  const stepOneStart = Date.now();
  let challengeResponse;
  try {
    challengeResponse = await fetch(targetUrl, { method: "GET" });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `Agent failed to reach merchant endpoint: ${err?.message ?? err}`,
      trace,
    });
  }

  if (challengeResponse.status !== 402) {
    // Either the endpoint returned 200 already (no auth required — unexpected
    // for a /premium/ route) or it returned an error.
    const bodyText = await safeText(challengeResponse);
    return res.status(502).json({
      ok: false,
      error: `Agent expected 402 but got ${challengeResponse.status} from ${targetUrl}`,
      details: bodyText.slice(0, 500),
      trace,
    });
  }

  // Prefer the WWW-Authenticate header (RFC-compliant); fall back to JSON body.
  const wwwAuth = challengeResponse.headers.get("www-authenticate") || "";
  let macaroon, invoice, paymentHash, amountSats;
  const parsedHeader = findL402Challenge(wwwAuth);
  if (parsedHeader) {
    macaroon = parsedHeader.macaroon;
    invoice = parsedHeader.invoice;
  }
  // Pull supplementary fields from the JSON body too (LE returns both).
  let challengeJson = null;
  try {
    challengeJson = await challengeResponse.json();
    macaroon ??= challengeJson?.l402?.macaroon;
    invoice ??= challengeJson?.l402?.invoice;
    paymentHash = challengeJson?.l402?.payment_hash;
    amountSats = challengeJson?.l402?.amount_sats;
  } catch {
    // body wasn't json; we have the header parse, that's enough.
  }

  if (!macaroon || !invoice) {
    return res.status(502).json({
      ok: false,
      error: "Agent could not parse macaroon or invoice from 402 response.",
      trace,
    });
  }

  trace.push({
    step: 1,
    label: "Requested resource — got 402",
    durationMs: Date.now() - stepOneStart,
    amountSats: amountSats ?? null,
    paymentHash: paymentHash ?? null,
  });

  if (amountSats && amountSats > MAX_SATS_PER_REQUEST) {
    return res.status(400).json({
      ok: false,
      error: `Invoice asks for ${amountSats} sats, demo cap is ${MAX_SATS_PER_REQUEST}. Refusing to pay.`,
      trace,
    });
  }

  // ── Step 2: pay the invoice via NWC ─────────────────────────────────────
  // Wallet timeout (25s) is intentionally shorter than this function's
  // maxDuration (60s in vercel.json) so a hung NWC reply throws a real
  // error inside the catch block instead of letting Vercel kill the
  // function and serve its plaintext error page (which the browser then
  // tries to parse as JSON and shows the visitor "Unexpected token 'A',
  // 'An error o'... is not valid JSON"). 25s also leaves ~35s headroom
  // for the L402 retry hop and serialization.
  const stepTwoStart = Date.now();
  const wallet = new NwcWallet(nwcUrl, 25_000);
  let preimage;
  try {
    preimage = await wallet.payInvoice(invoice);
  } catch (err) {
    const elapsedMs = Date.now() - stepTwoStart;
    return res.status(502).json({
      ok: false,
      error: `Agent wallet failed to pay invoice (after ${elapsedMs}ms): ${err?.message ?? err}`,
      trace,
    });
  }

  trace.push({
    step: 2,
    label: "Paid invoice over Lightning",
    durationMs: Date.now() - stepTwoStart,
    preimagePreview: preimage.slice(0, 16) + "…",
  });

  // ── Step 3: retry with L402 token ───────────────────────────────────────
  const stepThreeStart = Date.now();
  let finalResponse;
  try {
    finalResponse = await fetch(targetUrl, {
      method: "GET",
      headers: { Authorization: `L402 ${macaroon}:${preimage}` },
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `Agent retry failed: ${err?.message ?? err}`,
      trace,
    });
  }

  if (!finalResponse.ok) {
    const bodyText = await safeText(finalResponse);
    return res.status(502).json({
      ok: false,
      error: `Agent retry returned ${finalResponse.status} from ${targetUrl}`,
      details: bodyText.slice(0, 500),
      trace,
    });
  }

  const finalBody = await finalResponse.json();

  trace.push({
    step: 3,
    label: "Got the data",
    durationMs: Date.now() - stepThreeStart,
    httpStatus: finalResponse.status,
  });

  return res.status(200).json({
    ok: true,
    totalMs: Date.now() - startedAt,
    totalSats: amountSats ?? null,
    trace,
    final: finalBody,
  });
}

function inferOriginFromRequest(req) {
  // Vercel exposes the deployment URL via headers. Prefer x-forwarded-host
  // (the real public host), fall back to host header. Always use https.
  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "demo.lightningenable.com";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

function buildTargetUrl(origin, endpoint, body) {
  const url = new URL(`${origin}/api/premium/${endpoint}`);
  if (endpoint === "weather") {
    if (body.city) url.searchParams.set("city", String(body.city).slice(0, 64));
  } else if (endpoint === "btc-price") {
    if (body.currency)
      url.searchParams.set(
        "currency",
        String(body.currency).slice(0, 8).toUpperCase(),
      );
  }
  return url.toString();
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
