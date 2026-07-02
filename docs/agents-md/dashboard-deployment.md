## Dashboard Deployment

The dashboard frontend (`src/surface/mc/dashboard-v2/`) is a React app deployed to **Cloudflare Pages** as a separate step. It is NOT automatically deployed via GitHub — it requires a manual build + deploy.

**Project:** `grove-dashboard` on CF Pages → `grove.meta-factory.ai`. The DNS rename to `cortex.meta-factory.ai` is out of scope for v1 cortex (see `docs/plan-cortex-migration.md` open question 12) — operator-facing brand (`Cortex`) and the legacy DNS host can legitimately differ; rename is a separate post-MIG-8 phase with a 30-day redirect window.

**Deploy workflow:**

```bash
# 1. Build the frontend (from repo root)
bun build src/surface/mc/dashboard-v2/index.html --outdir dist/dashboard-v2 --target browser --splitting

# 2. Deploy to CF Pages
bunx wrangler pages deploy dist/dashboard-v2 --project-name grove-dashboard
```

The `build:dashboard` + `watch:dashboard` scripts in `package.json` codify step 1.

**`--splitting` is load-bearing** (G-1114.D): the Network graph view `React.lazy`-imports the heavy `@xyflow/react` + `elkjs` engine, and code-splitting is what lands that engine in a separate, lazily-loaded `network-canvas-*.js` chunk instead of the entry bundle. Without the flag bun inlines the dynamic import back into the single entry bundle (every principal then downloads the +0.62 MB-gzip graph engine for a tab they may never open). When deploying, ensure the build emits the `network-canvas-*` chunk alongside the entry — that confirms the split held.

**When to deploy:**
- After any change to `src/surface/mc/dashboard-v2/` files (app.tsx, types.ts, hooks, etc.)
- After merging a PR that modifies dashboard components
- The backend (`cortex` bot via `arc upgrade cortex`) and the frontend (CF Pages via `wrangler`) are deployed independently.

**Architecture:**
- `cortex` serves the REST API + WebSocket at `localhost:8767` locally, or via the CF Worker at `grove.meta-factory.ai/api/*` in production (`src/surface/mc/worker/`).
- The dashboard frontend is static HTML/JS hosted on CF Pages.
- Frontend connects to the API via URL params (`?api=`) or auto-detection.
- CF Access cookies cover dashboard + API on each TLD (`.ai`, `.dev`, `.io`) — no cross-origin cookie issue, no bypass-everyone policies (see Critical Rules).

## Deploy-surface confidentiality scan (opt-in wrappers)

Design doc §4 L6 (compass#81/#93). `scripts/scan-deploy-surface.ts` shells to the
installed `metafactory-actions` confidentiality-scan engine's `text` mode (tiers
2+3 — public shape patterns + the hashed denylist) over the exact file set a
deploy would ship, and three **NET-NEW, opt-in** `package.json` scripts wrap it
around the existing deploy commands. These are ADDITIVE — the manual commands
documented above (and the worker's own `bun run deploy` / `db:migrate`) are
unchanged and remain the canonical path; nothing here rewires them.

| Script | Wraps | Mode |
|---|---|---|
| `bun run deploy:dashboard` | `build:dashboard` → scan `dist/dashboard-v2/**` → `wrangler pages deploy` | **advisory** (warns, never blocks — see below) |
| `bun run deploy:worker` | scan `src/surface/mc/worker/src/**/*.ts` → `wrangler deploy` (worker's own `deploy` script) | **blocking** (exit 1 aborts the deploy) |
| `bun run db:migrate:safe` | scan `schema.sql` + `migrations/*.sql` → `wrangler d1 execute` (worker's own `db:migrate` script) | **advisory** (warns, never blocks) |

**Why `deploy:dashboard` is advisory, not blocking.** The production dashboard
build bundles third-party graph-layout code (`elkjs`, lazily chunked into
`network-canvas-*.js` per G-1114.D). That vendor code's minified output
contains large numeric constants that coincidentally match the scan's
17–20-digit platform-id shape — verified empirically at authoring time: a real
`bun run build:dashboard` trips 8 such findings, all inside vendor code, none a
real platform id. Hard-blocking would brick `deploy:dashboard` on every run.
Fixing this properly needs an upstream allow-rule (or vendor-chunk exclusion)
in `metafactory-actions`' `public-patterns.yaml` — out of scope for this repo.

**Why `db:migrate:safe` is advisory.** Sequencing constraint from the design
doc: this PR must not brick the canonical `db:migrate` command if the scan
trips block-tier on `schema.sql` / `migrations/*.sql`. `migrations/0002_seed_data.sql`
was verified clean (its only seeded identity is a documented placeholder,
cortex#1344) at authoring time — advisory mode is a safety margin against a
future regression,
not evidence of a known finding today.

**Why `deploy:worker` is blocking.** The worker ships unbundled first-party
TypeScript (`src/surface/mc/worker/src/**/*.ts`), verified clean (0 findings)
at authoring time, with no equivalent vendor-minification false-positive
surface — so there's no reason to soften the gate there.

Parked (not built here, per design doc §4 L6 + compass#93): the daemon-side
`src/adapters/discord/response-poster.ts` public-guild gate; rewiring the
canonical production deploy commands through the blocking scan; the arc-publish
pre-`arc upgrade` hook that would scan `agents.d/**`/`personas/**`/
`arc-manifest*.yaml` at package time.
