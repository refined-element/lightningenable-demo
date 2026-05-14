# Lightning Enable Demo — Deployment

Same pattern as `docs.lightningenable.com`, `a-commerce.lightningenable.com`,
`nostrwolfe.com`: Vercel watches the GitHub repo and auto-deploys every
push to `main`. No CLI required.

## First-time setup (one-time)

1. **Go to https://vercel.com/new** (logged in as the org that owns the other
   `refined-element` Vercel projects).
2. **Import Git Repository** → select `refined-element/lightningenable-demo`.
   First time importing from the `refined-element` GitHub org, Vercel may ask
   you to install/grant the Vercel GitHub App on the org — same one-time
   step as the other projects.
3. Vercel auto-detects the project type: static site (`public/`) plus Node
   serverless functions (`api/`). No build command or framework preset
   needed; the defaults are correct.
4. Before clicking Deploy, expand **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `LIGHTNING_ENABLE_API_KEY` | The demo merchant's LE API key. Paste at deploy time, never commit. |
   | `DEMO_AGENT_NWC_URL` | NWC connection URL for the demo agent's spending wallet. Placeholder `nostr+walletconnect://placeholder-replace-me` is OK to start; `/api/run-agent` returns an error until you swap in a real funded URL. |
   | `LIGHTNING_ENABLE_API_BASE_URL` _(optional)_ | Override the LE API base URL. Defaults to `https://api.lightningenable.com`. |

   **Apply to Production ONLY.** Do not enable these env vars for **Preview**
   on a public repo — preview deploys run code from every PR head, including
   from external contributors, and any PR could be crafted to exfiltrate the
   key. PR previews will still render the static frontend; calls to
   `/api/run-agent` and the L402 endpoints will return errors, which is the
   intended trade-off. If a contributor genuinely needs a working preview to
   test changes that exercise the API path, create a separately rotated,
   low-quota merchant key dedicated to preview and apply only that key to
   **Preview** — never the production key.

5. **Deploy.** Static + serverless deploy takes ~30s.

## Custom domain — `demo.lightningenable.com`

In the Vercel project: **Settings → Domains → Add Domain →
`demo.lightningenable.com`**. Vercel will show the exact Namecheap record
to add. Typically:

- **Type:** `CNAME`
- **Host:** `demo`
- **Value:** `cname.vercel-dns.com`
- **TTL:** Automatic

Add it at Namecheap (Domain List → Manage `lightningenable.com` →
Advanced DNS). Vercel auto-verifies and issues the SSL cert within
~5 min.

## Custom domain — apex `lightningenable.com` (Phase C, later)

When ready to promote the demo to the apex domain:

1. In the Vercel project **Settings → Domains**, add `lightningenable.com`
   (and `www.lightningenable.com` if desired).
2. Vercel will display the records to add at Namecheap. Typically:
   - **A Record (apex):** Host `@`, Value `76.76.21.21`, TTL Automatic.
   - **CNAME (www, optional):** Host `www`, Value `cname.vercel-dns.com`,
     TTL Automatic.
3. Add those at Namecheap → Advanced DNS. Vercel auto-verifies and issues
   the SSL cert (~5 min).
4. To consolidate SEO authority from the legacy marketing page onto the
   new apex, add this tag to the `<head>` of the legacy
   `refinedelement.com/products/lightning-enable` page:
   ```html
   <link rel="canonical" href="https://lightningenable.com/" />
   ```
   Google then treats the new apex as the authoritative source while the
   legacy page remains crawlable as a portfolio entry pointing at the
   product site.

## Updating env vars

After first deploy, env-var changes are made in **Project → Settings →
Environment Variables**. Changing a value does NOT automatically redeploy
the running prod build; redeploy the latest commit (Deployments → ⋮ →
Redeploy) to pick up the new value, or wait for the next git push to
`main`.

When the real NWC URL is in hand:
1. Settings → Environment Variables → edit `DEMO_AGENT_NWC_URL`.
2. Deployments → latest production deploy → ⋮ → **Redeploy**.

## Local dev (optional)

For local dev with `vercel dev` (live function reloading + real env from
Vercel):

```powershell
cd F:\lightningenable-demo
npm install -g vercel    # if not installed
vercel login             # interactive OAuth, one-time
vercel link              # interactive — pick the existing
                         # lightningenable-demo project
vercel env pull .env     # pulls production env vars into local .env
                         # (.env is gitignored)
vercel dev               # opens http://localhost:3000
```

`vercel login` and `vercel link` are only needed once per machine. Most
people never need to install the CLI at all — every deploy goes through
the GitHub integration above.

## Auto-deploy

Every push to `main` triggers a production deploy. Every push to a
non-`main` branch (or open PR) gets a preview deploy at a unique URL.
Vercel comments preview URLs on PRs automatically.
