/**
 * Public BTC/USD spot price for the demo's trace footer dollar conversion.
 *
 * Mirrors the multi-source / fail-loud pattern of the LE backend's
 * BitcoinPriceService (CoinGecko, Coinbase, Kraken in parallel,
 * first-success wins, NO hardcoded fallback). The demo refuses to display
 * a fake rate — if every source fails, the client gets a 503 and the
 * trace footer renders "(USD price unavailable)" instead of a stale
 * hardcoded number.
 *
 * Cached at the edge for 60 seconds (`Cache-Control: s-maxage=60`) plus
 * a brief stale-while-revalidate window so a momentary upstream failure
 * doesn't immediately stop returning a rate. The 503 error path
 * explicitly sets `Cache-Control: no-store` so intermediate caches don't
 * memoize "price unavailable" and pin the demo into a broken state past
 * the actual upstream recovery.
 *
 * Separate from `/api/premium/btc-price.js` — that endpoint is
 * L402-gated by design (it's part of the L402 demo). This one is
 * unpaywalled so the front-end can populate the trace-footer USD
 * estimate without paying a sat per page view.
 */

const PER_SOURCE_TIMEOUT_MS = 5000;

// Compose a per-source timeout signal with an external "winner" signal
// so that the moment one upstream succeeds, the other two in-flight
// requests are aborted instead of left to run to completion. Saves
// serverless execution time and avoids unnecessary load on the upstreams
// that lost the race.
async function fetchWithTimeout(url, externalSignal, timeoutMs = PER_SOURCE_TIMEOUT_MS) {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([timeoutCtrl.signal, externalSignal])
    : timeoutCtrl.signal;
  try {
    return await fetch(url, {
      signal,
      headers: {
        "User-Agent": "LightningEnable-Demo/1.0",
        "Accept": "application/json",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCoinGecko(externalSignal) {
  const res = await fetchWithTimeout(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    externalSignal
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const j = await res.json();
  const rate = j?.bitcoin?.usd;
  if (typeof rate !== "number" || rate <= 0) {
    throw new Error("CoinGecko response missing bitcoin.usd");
  }
  return rate;
}

async function fetchCoinbase(externalSignal) {
  const res = await fetchWithTimeout(
    "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    externalSignal
  );
  if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
  const j = await res.json();
  const raw = j?.data?.amount;
  const rate = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Coinbase response missing data.amount");
  }
  return rate;
}

async function fetchKraken(externalSignal) {
  const res = await fetchWithTimeout(
    "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    externalSignal
  );
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
  const j = await res.json();
  if (Array.isArray(j?.error) && j.error.length > 0) {
    throw new Error(`Kraken error: ${j.error[0]}`);
  }
  const result = j?.result;
  if (!result) throw new Error("Kraken response missing result");
  // Pair key is "XXBTZUSD" or "XBTUSD" depending on Kraken's mood.
  for (const key of Object.keys(result)) {
    const close = result[key]?.c;
    if (Array.isArray(close) && close[0]) {
      const rate = Number(close[0]);
      if (Number.isFinite(rate) && rate > 0) return rate;
    }
  }
  throw new Error("Kraken response missing close price");
}

async function firstSuccessful() {
  // Shared "winner" abort controller — aborted on first success so the
  // other two in-flight upstream fetches are cancelled, saving
  // serverless runtime and upstream load. AbortError thrown by losing
  // siblings is caught and discarded (expected cancellation).
  const winnerCtrl = new AbortController();
  const sources = [
    ["CoinGecko", fetchCoinGecko],
    ["Coinbase", fetchCoinbase],
    ["Kraken", fetchKraken],
  ];
  const labelled = sources.map(([name, fn]) =>
    fn(winnerCtrl.signal)
      .then((rate) => ({ rate, source: name }))
      .catch((err) => Promise.reject({ source: name, message: err?.message || String(err) }))
  );
  try {
    const winner = await Promise.any(labelled);
    // Cancel losing siblings — their fetches are still pending. The
    // AbortError they'll throw is swallowed by their .catch() above
    // (already a rejection), so this doesn't surface as an error.
    winnerCtrl.abort();
    return winner;
  } catch (agg) {
    const failures = (agg?.errors || []).map(
      (e) => `${e?.source || "?"}: ${e?.message || "unknown"}`
    );
    const err = new Error(failures.join("; ") || "all sources failed");
    err.failures = failures;
    throw err;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { rate, source } = await firstSuccessful();
    // 60s edge cache + 5 min stale-while-revalidate: a brief upstream
    // outage won't pop "price unavailable" if a fresh-ish cached value
    // is still on disk somewhere.
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({
      rate,
      source,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // No hardcoded fallback. Mirrors BitcoinPriceService behavior:
    // refuse to mis-price; the client renders "unavailable" instead.
    // `no-store` on this path is critical: without it, an intermediate
    // cache could pin a "price unavailable" 503 well past the upstream
    // recovery and freeze the demo in a broken state for that TTL.
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({
      error: "BTC price unavailable",
      details: err?.failures || [err?.message || "unknown"],
    });
  }
}
