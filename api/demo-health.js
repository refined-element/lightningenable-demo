/**
 * GET /api/demo-health
 *
 * Reports whether the demo's agent flow can run RIGHT NOW. The
 * frontend fetches this on page load and uses the result to either
 * enable the "Run the agent" button, show a low-balance warning
 * banner, or gray out the button entirely with an explanation.
 *
 * Why this exists:
 *   The agent flow's failure modes (wallet empty, NWC unresponsive,
 *   relay flaky) all manifest the same way to a prospect — a click
 *   that ends in an error. That gives the wrong impression of the
 *   product. Surfacing the wallet's state up front lets us:
 *     - gate the button before the visitor wastes a click
 *     - explain in copy that this is a demo wallet, not the product
 *     - keep the static code samples and explanation visible
 *
 * Response shape:
 *   {
 *     healthy:     boolean,           // true => button safe to enable
 *     status:      "ok" | "low" | "out" | "error",
 *     balanceSats: number | null,     // null when status = "error"
 *     reason:      string | null      // short human-readable detail
 *   }
 *
 * Thresholds:
 *   - "out"   < MIN_FOR_ONE_RUN  (can't safely pay even one demo call)
 *   - "low"   < LOW_BALANCE_SATS (one or two calls left)
 *   - "ok"    above that
 *   - "error" any time the NWC round-trip fails (timeout, relay,
 *             revoked connection) — failure-closed semantics so the
 *             button is gated rather than left enabled-but-broken.
 *
 * Cache: 60-second edge cache so we don't hammer NWC on every page
 * load. Stale-while-revalidate so a transient NWC blip doesn't
 * immediately flip the demo into "unavailable" for fresh visitors.
 */

import { getBalance } from "./_lib/nwc.js";

// Per-agent-run worst case (see MAX_SATS_PER_REQUEST in run-agent.js).
// Below this we can't promise even one successful flow.
const MIN_FOR_ONE_RUN = 30;

// Two or three demo calls of headroom — flip the banner to "low" so
// the operator gets a visible cue to refill before complete drain.
const LOW_BALANCE_SATS = 100;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const nwcUrl = process.env.DEMO_AGENT_NWC_URL;
  if (!nwcUrl) {
    // The demo isn't configured — treat as "error" so the frontend
    // gates the button. This is a real production misconfig case
    // (env var unset or stale placeholder).
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      healthy: false,
      status: "error",
      balanceSats: null,
      reason: "Demo agent wallet is not configured.",
    });
  }

  try {
    const { balanceSats } = await getBalance(nwcUrl, { timeoutMs: 8_000 });
    let status, healthy, reason;
    if (balanceSats < MIN_FOR_ONE_RUN) {
      status = "out";
      healthy = false;
      reason = `Wallet at ${balanceSats} sat — below the safe minimum for one demo call.`;
    } else if (balanceSats < LOW_BALANCE_SATS) {
      status = "low";
      healthy = true; // can still run, but the banner warns
      reason = `Wallet at ${balanceSats} sat — running low, refill soon.`;
    } else {
      status = "ok";
      healthy = true;
      reason = null;
    }

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({ healthy, status, balanceSats, reason });
  } catch (err) {
    // Failure-closed: if NWC won't respond, gate the button. Better
    // to under-promise availability than have visitors hit a hung
    // payment step.
    res.setHeader("Cache-Control", "no-store");
    const detail = String(err?.message || err).slice(0, 200);
    return res.status(200).json({
      healthy: false,
      status: "error",
      balanceSats: null,
      // Surface a brief reason but don't leak full traces — the
      // frontend will show a friendly version.
      reason: detail,
    });
  }
}
