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
  const elSummary = document.getElementById("run-summary");
  const elCity = document.getElementById("input-city");
  const elCurrency = document.getElementById("input-currency");
  const radios = document.querySelectorAll('input[name="endpoint"]');
  const paramRows = {
    weather: document.getElementById("param-weather"),
    "btc-price": document.getElementById("param-btc-price"),
  };

  // ── Demo-health gate ───────────────────────────────────────────────
  // Fetch /api/demo-health once at page load. If the demo's CoinOS
  // wallet is empty, NWC is unresponsive, or the env var is misconfig,
  // gate the button + show a banner so visitors don't waste a click
  // on a flow we know will fail. The static code samples + explanation
  // remain visible regardless — the product story doesn't depend on
  // the live wallet being funded.
  const elBanner = document.getElementById("demo-health-banner");
  fetch("/api/demo-health", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((h) => {
      if (!h) return;
      // status: "ok" | "low" | "out" | "error"
      if (h.status === "ok") return;

      // Render the banner copy. "low" still lets the button work; "out"
      // and "error" gray the button.
      if (h.status === "low") {
        const sats = h.balanceSats ?? "?";
        const unit = sats === 1 ? "sat" : "sats";
        elBanner.className = "demo-health-banner banner-low";
        elBanner.innerHTML = `
          <strong>Demo wallet running low.</strong>
          <span>~${escapeHtml(String(sats))} ${unit} remaining — the agent flow may stop working soon while we refill.</span>
        `;
      } else if (h.status === "out") {
        elBanner.className = "demo-health-banner banner-out";
        elBanner.innerHTML = `
          <strong>Demo wallet refill pending.</strong>
          <span>The live agent flow is paused while we top up the demo's CoinOS wallet. The code samples below still work — this just gates the live-execution button.</span>
        `;
        elBtn.disabled = true;
      } else {
        // error / unknown — failure-closed: gate the button
        elBanner.className = "demo-health-banner banner-error";
        elBanner.innerHTML = `
          <strong>Demo agent temporarily unavailable.</strong>
          <span>We're working on it. The code samples and walkthrough below describe the same flow.</span>
        `;
        elBtn.disabled = true;
      }
      elBanner.classList.remove("hidden");
    })
    .catch(() => {
      // /api/demo-health itself failed (network error, 5xx, etc.).
      // Failure-closed per the design: gate the button and show the
      // same banner as the "error" status case so the prospect sees
      // a graceful explanation rather than a click that goes nowhere.
      elBanner.className = "demo-health-banner banner-error";
      elBanner.innerHTML = `
        <strong>Demo agent temporarily unavailable.</strong>
        <span>We're working on it. The code samples and walkthrough below describe the same flow.</span>
      `;
      elBanner.classList.remove("hidden");
      elBtn.disabled = true;
    });

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
    if (elSummary) {
      elSummary.classList.add("hidden");
      elSummary.innerHTML = "";
    }

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
      // Friendly mapping for known failure modes. The agent endpoint
      // returns raw NWC errors which read as "this product is broken"
      // to a prospect. Map the common cases to copy that says "this
      // demo's wallet is being refilled / hit a hiccup" — same idea
      // as the health-check banner but for the race-condition case
      // where health was OK on page load but the wallet drained
      // between then and the click.
      const friendly = mapAgentError(data?.error || "");
      appendTraceLine("⚠", friendly, true);
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

    // Plain-English interpretation of what just happened, for the
    // visitor who didn't read the JSON. Only renders on a clean
    // success (ok=true, totalSats>0, final.l402.valid=true). The
    // strings here use innerHTML to bold a couple keywords; the
    // dynamic values (sats, ms) are passed through escapeHtml so a
    // malformed backend response can't inject markup.
    if (elSummary && data.ok && data.totalSats > 0 && data?.final?.l402?.valid) {
      const sats = escapeHtml(String(data.totalSats));
      const ms = data.totalMs != null ? escapeHtml(String(data.totalMs)) : null;
      const endpointKind = escapeHtml(String(data?.final?.l402?.resource || data?.endpoint || "the paid endpoint"));
      const timing = ms ? ` in <strong>${ms} ms</strong>` : "";
      elSummary.innerHTML =
        `✓ The agent paid <strong>${sats} sat${sats === "1" ? "" : "s"}</strong>${timing}, ` +
        `got the response, and your provider account would now be ${sats} sat${sats === "1" ? "" : "s"} ` +
        `heavier — with zero per-transaction fees taken out. ` +
        `This is the same flow your customers' agents would run against your API at <code>${endpointKind}</code>.`;
      elSummary.classList.remove("hidden");
    }

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
    // Don't un-disable a button that was gated by the demo-health check
    // at page load (banner already explains why). Only re-enable if
    // the button got disabled by THIS click handler's loading state.
    if (elBanner && !elBanner.classList.contains("hidden")
        && (elBanner.classList.contains("banner-out") || elBanner.classList.contains("banner-error"))) {
      elBtn.textContent = "⚡ Run the agent";
      return;
    }
    elBtn.disabled = false;
    elBtn.textContent = "⚡ Run the agent";
  }

  // Map raw agent-endpoint error strings to friendlier copy. The agent
  // returns things like "Agent wallet failed to pay invoice (after
  // 25164ms): Wallet returned NWC error INSUFFICIENT_BALANCE: ..."
  // which makes the product look broken when it's really just the
  // demo wallet's state. These mappings preserve enough signal for
  // engineers (the raw error is still in network responses) while
  // showing prospects a friendlier message.
  function mapAgentError(raw) {
    const s = String(raw);
    if (/INSUFFICIENT_BALANCE/i.test(s) || /insufficient.+balance/i.test(s)) {
      return "Demo wallet just ran out of sats — refill in progress. Try again in a few minutes.";
    }
    if (/RATE_LIMITED/i.test(s)) {
      return "Demo wallet is being rate-limited. Try again in a minute.";
    }
    if (/NWC payment timed out/i.test(s) || /NWC get_balance timed out/i.test(s)) {
      return "Demo wallet didn't respond in time — usually a relay hiccup. Try again in a few seconds.";
    }
    if (/Relay rejected/i.test(s) || /WebSocket error/i.test(s)) {
      return "Demo wallet's Nostr relay had a connection issue. Try again in a few seconds.";
    }
    if (/Demo agent wallet is not configured/i.test(s)) {
      return "Demo wallet is being reconfigured. The code samples below still describe the working flow.";
    }
    // Unknown — leave the raw signal in the trace below so support can
    // diagnose, but front the line with friendlier framing.
    return `Agent ran into an issue: ${s}`;
  }

  // ── Dashboard-screenshot lightbox ──────────────────────────────────
  // Clicking any dashboard-card screenshot opens it full-size in the
  // native <dialog> element added at the bottom of index.html. Uses
  // showModal() so Esc-to-close is free, plus a tiny backdrop-click
  // handler since <dialog> doesn't close on backdrop click natively.
  // ImageElement.src is set right before each open, so the same
  // <dialog> instance serves all four cards without per-card markup.
  //
  // Accessibility: <img> elements aren't keyboard-focusable by default,
  // so we set tabindex="0" + role="button" on each lightbox-able img
  // and add an Enter/Space key handler. Keyboard and screen-reader
  // users get the same zoom affordance.
  //
  // Re-entrancy: showModal() throws InvalidStateError if the dialog is
  // already open. Guard with .open check so rapid double-clicks (or
  // clicking another card while one is open) silently swap the image
  // instead of crashing.
  const lightbox = document.getElementById("screenshot-lightbox");
  if (lightbox) {
    const lightboxImg = lightbox.querySelector(".lightbox-img");
    const lightboxClose = lightbox.querySelector(".lightbox-close");

    function openLightbox(img) {
      if (!lightboxImg) return;
      lightboxImg.src = img.src;
      lightboxImg.alt = img.alt;
      if (!lightbox.open) {
        try { lightbox.showModal(); }
        catch (e) {
          // Older browsers (legacy Safari) may not support showModal.
          // Fall back to the standard `open` attribute so the dialog
          // is at least visible — no focus trap, but better than a
          // silent failure.
          lightbox.setAttribute("open", "");
        }
      }
    }

    document.querySelectorAll(".dashboard-card .dashboard-img").forEach((img) => {
      img.setAttribute("tabindex", "0");
      img.setAttribute("role", "button");
      img.setAttribute("aria-label", `Open full-size: ${img.alt || "screenshot"}`);
      img.addEventListener("click", () => openLightbox(img));
      img.addEventListener("keydown", (e) => {
        // Enter and Space are the standard activation keys for a
        // button-like control. preventDefault on Space stops page
        // scrolling.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openLightbox(img);
        }
      });
    });
    // Backdrop click closes the dialog. The native <dialog> backdrop
    // is the dialog element itself when you click outside its content,
    // so target === lightbox identifies a backdrop click reliably.
    //
    // `closeLightbox()` mirrors the openLightbox fallback path —
    // older browsers without <dialog>.close() get the `open` attribute
    // removed manually instead. Without this, clicking the close
    // button on legacy browsers would silently no-op.
    function closeLightbox() {
      if (typeof lightbox.close === "function") {
        try { lightbox.close(); return; } catch { /* fall through */ }
      }
      lightbox.removeAttribute("open");
    }
    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox) closeLightbox();
    });
    lightboxClose?.addEventListener("click", closeLightbox);
  }
})();
