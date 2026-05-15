/**
 * Merchant endpoint: GET /api/premium/weather?city=Miami
 *
 * Issues a 402 Payment Required + Lightning invoice when the request has no
 * valid L402 token. Returns 200 + weather data when a valid token is supplied.
 *
 * This is what every "monetize an API with Lightning Enable" customer does
 * in their own code: wrap a route with the L402 middleware, charge sats,
 * keep the rest of their handler unchanged.
 *
 * Upstream data: Open-Meteo (free, no auth, no per-call cost).
 */

import { L402Server } from "l402-server";

const PRICE_SATS = 1;

const apiKey = process.env.LIGHTNING_ENABLE_API_KEY;
const baseUrl =
  process.env.LIGHTNING_ENABLE_API_BASE_URL ||
  "https://api.lightningenable.com";

// Lazily construct so build-time prerender doesn't require the env var.
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

  // Accept "Miami, FL" / "Paris, France" / etc. by taking just the
  // part before the first comma. Open-Meteo's geocoder matches the
  // `name` field literally — "Miami, FL" returns zero results, but
  // "Miami" returns Miami, FL (highest-pop) as the first match.
  // We trade away precise state/country disambiguation (so
  // "Miami, OH" still returns Miami, FL) for the much more common
  // "user typed the city with a qualifier" path working at all.
  const rawCity = (req.query.city || "Miami").toString().slice(0, 64);
  const city = rawCity.split(",")[0].trim() || "Miami";
  const auth = req.headers.authorization || "";
  const parsed = parseL402(auth);

  // No credential → mint a 402 challenge.
  if (!parsed) {
    try {
      // `idempotencyKey` is unique per call here so each visitor click
      // on the public demo gets a fresh Lightning invoice. The LE
      // producer API dedupes by resource+price within a 60s window by
      // default, which is the correct behavior for real merchants
      // (prevents charging twice on a network retry) but the wrong
      // behavior for a public demo where back-to-back clicks need
      // independent invoices. A real merchant copying this file as a
      // starting point should DELETE the `idempotencyKey` line to
      // restore retry-safe defaults.
      const challenge = await l402().createChallenge({
        resource: `/api/premium/weather`,
        priceSats: PRICE_SATS,
        description: `Weather for ${city}`,
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

  // Credential present → verify with the producer API.
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

  // Token good — fetch the upstream data and return it.
  const weather = await fetchWeather(city);
  return res.status(200).json({
    city,
    ...weather,
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

/**
 * Fetch current weather via Open-Meteo (free, no auth). Geocodes the city
 * name first, then queries the current-weather endpoint.
 */
async function fetchWeather(city) {
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`,
    );
    const geoData = await geo.json();
    const place = geoData?.results?.[0];
    if (!place) {
      return { error: "City not found", temperature_f: null, conditions: "unknown" };
    }
    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current_weather=true&temperature_unit=fahrenheit`,
    );
    const wData = await w.json();
    const cw = wData?.current_weather;
    return {
      temperature_f: cw?.temperature ?? null,
      wind_mph: cw?.windspeed ?? null,
      conditions: weatherCodeToText(cw?.weathercode),
      country: place.country,
      lat: place.latitude,
      lon: place.longitude,
    };
  } catch (err) {
    return {
      error: "Upstream weather provider failed",
      message: err?.message ?? String(err),
      temperature_f: null,
      conditions: "unknown",
    };
  }
}

function weatherCodeToText(code) {
  if (code == null) return "unknown";
  if (code === 0) return "clear sky";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 67) return "rainy";
  if (code <= 77) return "snowy";
  if (code <= 82) return "showers";
  if (code <= 99) return "thunderstorm";
  return "unknown";
}
