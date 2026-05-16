# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project Overview

**Lightning Enable marketing site** — the production homepage at `https://lightningenable.com` (apex 307→`www.lightningenable.com`). Single-page static site with an embedded **live agentic L402 demo**: visitors click "Run the agent" and an autonomous agent on the server runs the full L402 buy flow against the LE producer API (`402 → pay invoice → retry with credential → 200`), settling real Bitcoin over the Lightning Network in ~1-2 seconds. Real Lightning, ≈ $0.0008 per click.

**Brand position (preserve verbatim):**
- Lightning Enable is **infrastructure for agentic commerce over Lightning**.
- The product lets software pay software, per request, over Lightning.
- Lightning Enable does NOT hold funds (Strike or OpenNode does).
- The marketing line: "Monetize your API for AI agents."

**Repo / dir naming:**
- GitHub: `refined-element/lightningenable-site` (renamed from `lightningenable-demo` on 2026-05-15)
- Local dir: `F:\lightningenable-demo` (intentionally kept; renaming the local dir would mass-break my own git history)
- Vercel project name: `lightningenable-site` (or `lightningenable-demo` legacy — match what's in Vercel UI)

**Tech stack:** Static HTML/CSS/JS in `public/` + Node 20 Vercel serverless functions in `api/`. No framework; deliberately minimal. NWC + LNURL paid out of `api/run-agent.js`. OpenNode REST API for the daily refill loop.

## Build & Run

```bash
npm install        # one-time
npm test           # node:test runner — parser + redaction + balance-pattern unit tests
npx vercel dev     # local dev at http://localhost:3000 (Vercel-aware; pulls env vars)
```

Production: push to `main` → Vercel auto-deploys.

## Architecture

```
lightningenable-site/
├── public/
│   ├── index.html          Homepage (hero, demo, L402 callout, why-now, revenue stream, code, dashboard, trust, pricing)
│   ├── styles.css          Dark theme; Inter + JetBrains Mono; Stripe/Tempo-style glass header
│   ├── app.js              Demo widget JS — calls /api/run-agent, animates trace, surfaces plain-English summary
│   ├── llms.txt            Agent / LLM-readable site summary
│   ├── robots.txt          Allow-all + sitemap reference
│   ├── sitemap.xml         Single-page sitemap
│   ├── favicon.svg
│   ├── images/             logo.svg, logo-icon.png, og-card.png (1200x630 social card)
│   └── dashboard/          Dashboard screenshots embedded in the trust section
├── api/
│   ├── premium/
│   │   ├── weather.js      Merchant endpoint — L402-gated weather (Open-Meteo upstream, free)
│   │   └── btc-price.js    Merchant endpoint — L402-gated BTC price (CoinGecko upstream, free)
│   ├── run-agent.js        Agent — autonomously buys from the merchant endpoints
│   ├── demo-refill.js      Admin-keyed OpenNode → CoinOS refill (called by daily-refill.yml at 11:30 UTC)
│   └── demo-health.js      Public health gate used by the homepage banner
├── .github/workflows/
│   ├── daily-refill.yml    11:30 UTC, OpenNode → CoinOS 200 sats, opens GitHub Issue on failure
│   └── daily-smoke.yml     12:07 UTC, full agent flow, alternates weather/btc-price daily
├── tests/                  Node:test runner
└── vercel.json             Function maxDurations + caching headers
```

## Production surfaces

| Surface | URL | Notes |
|---|---|---|
| Marketing site (apex) | `https://lightningenable.com/` | 307 → www (Vercel-managed redirect, only direction available) |
| Marketing site (canonical) | `https://www.lightningenable.com/` | The actual serving surface; canonical tag points here |
| Monitoring alias | `https://demo.lightningenable.com/` | Same Vercel project, permanent alias for the daily smoke + refill crons. DO NOT REMOVE — the workflows depend on it as a stable target separate from the apex. |

**SEO files** (all served by Vercel, must remain reachable):
- `/robots.txt` — sets sitemap location, allow-all
- `/sitemap.xml` — homepage only (single-page site)
- `/llms.txt` — agent / LLM-readable site summary
- `/images/og-card.png` — 1200x630 social link preview

## Demo wallet + funding loop

The "Run the agent" button on the homepage drains a small **CoinOS NWC wallet** (account `sole86@coinos.io`). Each successful agent run pays the LE producer API ~1 sat. The OpenNode merchant balance on the LE API side accumulates those sats. The **daily-refill.yml** cron at 11:30 UTC moves 200 sats back from OpenNode → CoinOS via the `/api/demo-refill` endpoint, closing the loop so the demo stays funded without manual intervention.

**Demo wallet abuse defense** (layered):
- Per-IP cooldown (5s default), recorded AFTER env-var validation
- 25-sat per-call cap (hardcoded)
- Referer allowlist (lightningenable.com, www.lightningenable.com, demo.lightningenable.com, localhost:3000)
- Health-gate banner (warns visitors if wallet is low BEFORE they click)
- Friendly NWC error mapping (no raw stack traces in UX)

**Refill endpoint (`/api/demo-refill`) security:**
- `Authorization: Bearer <DEMO_REFILL_ADMIN_KEY>` (SHA-256 hashed both sides + constant-time compare; case-insensitive `Bearer` scheme)
- Hardcoded destination + amount (admin key leak can't redirect funds)
- OpenNode API base allowlisted (production or dev only)
- BOLT-11 amount verification (rejects mismatched invoice; rejects > 100M sats; rejects implausible digit lengths)
- LNURL callback host + protocol verification (https-only, host must match the configured lightning address)
- Insufficient-balance regex deliberately tight — must mention `balance` or `funds` with a quantity word. `"Insufficient permissions"` etc. (auth failures) intentionally do NOT match and alert via the issue-tracking path.
- Two-layer credential redaction on echoed errors (exact-key scrub + 65+-char opaque-token scrub; UUIDs + SHA-256 hashes pre-extracted and preserved for diagnostic value)

## Daily monitoring workflows

Both workflows open / comment on a GitHub Issue on failure, with full `gh issue create` fallback machinery (label fallback, stderr capture, lookup-failed-but-still-create-a-fresh-issue path) so an alert is never silently dropped.

**daily-smoke.yml** — 12:07 UTC:
- Alternates `weather` and `btc-price` endpoints by day-of-year parity (even → weather, odd → btc-price) for full upstream coverage without doubling daily wallet drain.
- 5 success signals: HTTP 200, `ok:true`, `totalSats > 0`, `final.l402.valid:true`, `final.error` empty.
- Endpoint-specific data assertion: `final.temperature_f` numeric for weather, `final.price` numeric for btc-price. Catches degraded payloads that pass other signals.
- Retry: 2 attempts, 60s apart.
- Error cascade for the failure body (most-specific first): `final.error` → `.error` → degraded-payload → generic placeholder.

**daily-refill.yml** — 11:30 UTC (37 min before smoke, so a fresh refill is in place when smoke runs):
- Calls `/api/demo-refill` with the admin Bearer key.
- Handles graceful-skip path: `ok:true` + `skipped:true` when OpenNode balance is too low (idle-period normal — not alertable).

**Curl `--max-time` budget rationale (in the workflow yml):** Vercel function `maxDuration: 60` in `vercel.json` for `/api/demo-refill`. Worst-case upstream wall-clock: 10s (CoinOS lnurlp) + 10s (CoinOS callback) + 15s (OpenNode withdrawal) + 5-10s cold-start overhead = ~45s. Curl `--max-time 75` leaves 15s headroom.

## Conventions

**Never `git add -A` or `git add .`** — this working tree carries persistent untracked artifacts (Vercel `.env`, IDE files). Always enumerate explicit paths; `git status` first.

**Workflow target URLs stay on `demo.lightningenable.com`** — not the apex. Splitting "main URL" from "URL my monitoring hits" reduces blast radius if anything funny happens at the apex. The canonical tag handles SEO consolidation regardless.

**`api/run-agent.js` ALLOWED_ORIGINS** already includes both `lightningenable.com` and `www.lightningenable.com` — no change needed on the agent-side after the LS-C cutover.

**Pricing card facts (do NOT add unshipped claims):**
- Individual: Strike only as settlement provider
- Business: Strike OR OpenNode (OpenNode requires KYB, hence Business-only)
- Business: white-glove onboarding + direct founder access (real differentiators)
- Higher rate limits and multi-currency are NOT separately offered per tier — anyone implying that on the marketing surface is wrong. See commit `3beaf21` for the correction.

**Trust strip merchants (verifiable proof, not aspirational):**
- Great Ghee — `https://greatghee.com/` — Shopify
- Salt of the Earth — `https://drinksote.com/` — Shopify (SOTE = drinksote = Salt of the Earth, same merchant under different names)

**Cookie-aware root redirect on api.lightningenable.com** (LE API side, not this repo): authenticated DashboardCookie → `/dashboard`, anonymous → `https://www.lightningenable.com/`. The marketing-site pricing CTAs hit `api.lightningenable.com/Checkout` which is unaffected.

## Smoke testing locally

```bash
npx vercel dev                                          # spins up localhost:3000
curl -X POST http://localhost:3000/api/run-agent \      # exercises full agent path
  -H 'Content-Type: application/json' \
  -d '{"endpoint":"weather","city":"Miami"}'
```

You'll need `LIGHTNING_ENABLE_API_KEY` and `DEMO_AGENT_NWC_URL` in your local `.env` (pulled from Vercel via `vercel env pull .env` after `vercel link`).

## Related repos

- **Lightning Enable monorepo** (`F:\lightning-enable`, GitHub `refined-element/lightning-enable`) — the LE API + Core/Data/Kentico packages + docs-site. Marketing site here calls `https://api.lightningenable.com/` for L402 challenges + verifications.
- **Refined Element site** (`F:\RefinedElement\re-xbk`, GitHub `refined-element/refined-element-site`) — the consultancy marketing site. Hosts `refinedelement.com`. `/products/lightning-enable` is a pared portfolio entry that hands off here via canonical override.
