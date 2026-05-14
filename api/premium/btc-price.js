/**
 * Merchant endpoint: GET /api/premium/btc-price?currency=USD
 *
 * Same L402 shape as /api/premium/weather. Returns the current BTC price plus
 * 24-hour change for the requested fiat currency. Demonstrates a second
 * paid endpoint living next to the weather one, with a different upstream
 * data source — illustrating that L402 is endpoint-agnostic.
 *
 * Upstream data: CoinGecko's public price API (free, no auth, lenient rate
 * limit).
 */

import { L402Server } from "l402-server";

const PRICE_SATS = 1;
const SUPPORTED_CURRENCIES = new Set([
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CAD",
  "AUD",
  "CHF",
  "CNY",
]);

const apiKey = process.env.LIGHTNING_ENABLE_API_KEY;
const baseUrl =
  process.env.LIGHTNING_ENABLE_API_BASE_URL ||
  "https://api.lightningenable.com";

let _l402 = null;
function l402() {
  if (_l402) return _l402;
  if (!apiKey) {
    throw new Error(
      "LIGHTNING_ENABLE_API_KEY is not set. Configure it in Vercel project settings.",
    );
  }
  _l402 = new L402Server({ apiKey, baseUrl });
  return _l402;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const requestedCurrency = (req.query.currency || "USD")
    .toString()
    .toUpperCase()
    .slice(0, 8);
  const currency = SUPPORTED_CURRENCIES.has(requestedCurrency)
    ? requestedCurrency
    : "USD";

  const auth = req.headers.authorization || "";
  const parsed = parseL402(auth);

  if (!parsed) {
    try {
      // `idempotencyKey` is unique per call so each visitor click on
      // the public demo gets a fresh Lightning invoice. See the same
      // comment in `weather.js` for why this is a demo-specific
      // override; real merchants should drop the field to restore
      // retry-safe deduplication.
      const challenge = await l402().createChallenge({
        resource: `/api/premium/btc-price`,
        priceSats: PRICE_SATS,
        description: `BTC price in ${currency}`,
        idempotencyKey: crypto.randomUUID(),
      });
      res.setHeader(
        "WWW-Authenticate",
        `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`,
      );
      return res.status(402).json({
        error: "Payment Required",
        l402: {
          macaroon: challenge.macaroon,
          invoice: challenge.invoice,
          amount_sats: challenge.priceSats,
          payment_hash: challenge.paymentHash,
          expires_at: challenge.expiresAt,
          resource: challenge.resource,
        },
      });
    } catch (err) {
      return res
        .status(502)
        .json({ error: "Bad Gateway", message: err?.message ?? String(err) });
    }
  }

  let verification;
  try {
    verification = await l402().verifyToken({
      macaroon: parsed.macaroon,
      preimage: parsed.preimage,
    });
  } catch (err) {
    return res
      .status(502)
      .json({ error: "Bad Gateway", message: err?.message ?? String(err) });
  }

  if (!verification.valid) {
    return res.status(401).json({
      error: "Unauthorized",
      message: verification.error || "Invalid L402 credential.",
    });
  }

  const price = await fetchBtcPrice(currency);
  return res.status(200).json({
    currency,
    ...price,
    timestamp: new Date().toISOString(),
    l402: {
      valid: true,
      resource: verification.resource,
      merchantId: verification.merchantId,
      amountSats: verification.amountSats,
      paymentHash: verification.paymentHash,
    },
  });
}

function parseL402(authHeader) {
  if (!authHeader || !authHeader.startsWith("L402 ")) return null;
  const rest = authHeader.slice("L402 ".length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  return {
    macaroon: rest.slice(0, idx).trim(),
    preimage: rest.slice(idx + 1).trim(),
  };
}

async function fetchBtcPrice(currency) {
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${currency.toLowerCase()}&include_24hr_change=true&include_last_updated_at=true`,
    );
    if (!r.ok) {
      return {
        error: "Upstream provider returned " + r.status,
        price: null,
        change_24h_percent: null,
      };
    }
    const data = await r.json();
    const bucket = data?.bitcoin;
    if (!bucket) {
      return {
        error: "Bitcoin price not in response",
        price: null,
        change_24h_percent: null,
      };
    }
    const k = currency.toLowerCase();
    return {
      price: bucket[k] ?? null,
      change_24h_percent: bucket[`${k}_24h_change`] ?? null,
      source: "coingecko.com",
      source_updated_at: bucket.last_updated_at
        ? new Date(bucket.last_updated_at * 1000).toISOString()
        : null,
    };
  } catch (err) {
    return {
      error: "Upstream price provider failed",
      message: err?.message ?? String(err),
      price: null,
      change_24h_percent: null,
    };
  }
}
