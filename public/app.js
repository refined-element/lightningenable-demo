/**
 * Demo widget — kicks off the agent flow and animates the trace.
 *
 * Sends POST /api/run-agent with the visitor's chosen endpoint + params.
 * The server runs the full L402 buy (call → 402 → pay invoice → retry →
 * 200) and returns a trace + final response. We render the trace as a
 * timeline, one line at a time, then dump the final response.
 *
 * No framework. ~120 lines of vanilla JS. Aim is for the source view of
 * the page to be readable end-to-end.
 */

(() => {
  const elBtn = document.getElementById("run-agent");
  const elTrace = document.getElementById("trace");
  const elResult = document.getElementById("result");
  const elCity = document.getElementById("input-city");
  const elCurrency = document.getElementById("input-currency");
  const radios = document.querySelectorAll('input[name="endpoint"]');
  const paramRows = {
    weather: document.getElementById("param-weather"),
    "btc-price": document.getElementById("param-btc-price"),
  };

  // ── BTC rate (no hardcoded fallback) ────────────────────────────────
  // Fire-and-forget at page load. /api/btc-price races CoinGecko +
  // Coinbase + Kraken (mirrors LE's BitcoinPriceService); on total
  // failure we leave window.__BTC_RATE__ undefined and the trace footer
  // renders "(USD price unavailable)" rather than a fake number.
  window.__BTC_RATE__ = undefined;
  fetch("/api/btc-price", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((j) => {
      if (typeof j?.rate === "number" && j.rate > 0) {
        window.__BTC_RATE__ = { rate: j.rate, source: j.source || "unknown" };
      }
    })
    .catch(() => {
      // Silent — the trace footer handles the unavailable case directly.
    });

  // ── Endpoint switcher ───────────────────────────────────────────────
  radios.forEach((r) =>
    r.addEventListener("change", () => {
      Object.entries(paramRows).forEach(([name, el]) => {
        el.classList.toggle("hidden", name !== r.value);
      });
    }),
  );

  // ── Code-tab switcher ────────────────────────────────────────────────
  document.querySelectorAll(".tab").forEach((tab) => {
    if (tab.classList.contains("tab-disabled")) return;
    tab.addEventListener("click", () => {
      const which = tab.dataset.tab;
      document
        .querySelectorAll(".tab")
        .forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll("[data-tab-content]").forEach((c) => {
        c.classList.toggle("hidden", c.dataset.tabContent !== which);
      });
      document.querySelectorAll("[data-install]").forEach((c) => {
        c.classList.toggle("hidden", c.dataset.install !== which);
      });
    });
  });

  // ── Run-agent click ──────────────────────────────────────────────────
  elBtn.addEventListener("click", async () => {
    const selected = document.querySelector('input[name="endpoint"]:checked');
    const endpoint = selected ? selected.value : "weather";
    const body = { endpoint };
    if (endpoint === "weather") body.city = elCity.value.trim() || "Miami";
    if (endpoint === "btc-price")
      body.currency = elCurrency.value || "USD";

    elBtn.disabled = true;
    elBtn.textContent = "⚡ Running…";
    elTrace.innerHTML = "";
    elTrace.classList.remove("hidden");
    elResult.classList.add("hidden");
    elResult.textContent = "";

    const pendingLine = appendTraceLine("·· ms", "Sending request to /api/run-agent…");

    let res, data;
    try {
      res = await fetch("/api/run-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      data = await res.json();
    } catch (err) {
      pendingLine.querySelector(".trace-text").textContent =
        "Network error: " + (err?.message || err);
      pendingLine.classList.add("error");
      resetButton();
      return;
    }

    if (!res.ok || !data.ok) {
      pendingLine.remove();
      appendTraceLine("⚠", `Agent failed: ${data?.error || "unknown error"}`, true);
      if (data?.details) appendTraceLine(" ", data.details, true);
      resetButton();
      return;
    }

    // Replace the "Sending request" line with the actual trace, animating.
    pendingLine.remove();
    for (const step of data.trace) {
      const extras = [];
      if (step.amountSats != null) extras.push(`${step.amountSats} sat`);
      if (step.paymentHash)
        extras.push(`hash: ${String(step.paymentHash).slice(0, 12)}…`);
      if (step.preimagePreview)
        extras.push(`preimage: ${step.preimagePreview}`);
      if (step.httpStatus != null) extras.push(`HTTP ${step.httpStatus}`);
      const ms = `${step.durationMs.toString().padStart(4, " ")} ms`;
      const text = step.label;
      const meta = extras.length ? extras.join(" · ") : "";
      appendTraceLine(ms, text, false, meta);
      // brief stagger so the eye can follow each step appearing
      await delay(180);
    }

    // Summary line at the bottom. Dollar value uses a real BTC/USD rate
    // fetched from /api/btc-price (multi-source: CoinGecko, Coinbase,
    // Kraken — fail-loud, no hardcoded fallback). If the rate fetch
    // failed at page load, render the sat count only and a clear
    // "(USD price unavailable)" note — never a fake dollar value.
    // All interpolated values are routed through escapeHtml() before
    // being assembled into innerHTML — even server-controlled fields
    // (totalMs/totalSats) and the BTC source string are escaped on
    // principle so a future regression in the upstream can't open an
    // XSS hole here.
    const totalLine = document.createElement("div");
    totalLine.className = "trace-summary";
    const btc = window.__BTC_RATE__;
    let usdSegment = "";
    // != null gates on "the backend reported a sat count" — even 0 is a
    // real value here (free-tier endpoints, settled-but-zero refunds)
    // and deserves a $0.00 segment rather than a missing one.
    if (data.totalSats != null) {
      if (btc && btc.rate > 0) {
        const usd = (data.totalSats / 100_000_000) * btc.rate;
        const formatted = usd < 0.01
          ? `$${usd.toFixed(6)}`
          : `$${usd.toFixed(4)}`;
        usdSegment = `(≈ ${escapeHtml(formatted)} at $${escapeHtml(Math.round(btc.rate).toLocaleString())}/BTC via ${escapeHtml(btc.source)})`;
      } else {
        usdSegment = `(USD price unavailable)`;
      }
    }
    const safeMs = escapeHtml(String(data.totalMs));
    const safeSats = escapeHtml(String(data.totalSats ?? "?"));
    totalLine.innerHTML = `
      <strong>Done in ${safeMs} ms.</strong>
      Spent ${safeSats} sat
      ${usdSegment}
    `;
    elTrace.appendChild(totalLine);

    // Render the final response object
    elResult.textContent = JSON.stringify(data.final, null, 2);
    elResult.classList.remove("hidden");

    resetButton();
  });

  function appendTraceLine(time, text, isError = false, meta = "") {
    const line = document.createElement("div");
    line.className = "trace-line" + (isError ? " error" : "");
    line.innerHTML = `
      <span class="trace-time">${escapeHtml(String(time))}</span>
      <span class="trace-text">${escapeHtml(text)}${
        meta ? `<small>${escapeHtml(meta)}</small>` : ""
      }</span>
    `;
    elTrace.appendChild(line);
    return line;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function resetButton() {
    elBtn.disabled = false;
    elBtn.textContent = "⚡ Run the agent";
  }
})();
