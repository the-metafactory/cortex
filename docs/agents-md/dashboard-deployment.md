## Dashboard Deployment

The dashboard frontend (`src/surface/mc/dashboard-v2/`) is a React app deployed to **Cloudflare Pages** as a separate step. It is NOT automatically deployed via GitHub — it requires a manual build + deploy.

**Project:** `grove-dashboard` on CF Pages → `grove.meta-factory.ai`. The DNS rename to `cortex.meta-factory.ai` is out of scope for v1 cortex (see `docs/plan-cortex-migration.md` open question 12) — operator-facing brand (`Cortex`) and the legacy DNS host can legitimately differ; rename is a separate post-MIG-8 phase with a 30-day redirect window.

**Deploy workflow:**

```bash
# 1. Build the frontend (from repo root)
bun build src/surface/mc/dashboard-v2/index.html --outdir dist/dashboard-v2 --target browser

# 2. Deploy to CF Pages
bunx wrangler pages deploy dist/dashboard-v2 --project-name grove-dashboard
```

The `build:dashboard` + `watch:dashboard` scripts in `package.json` codify steps 1.

**When to deploy:**
- After any change to `src/surface/mc/dashboard-v2/` files (app.tsx, types.ts, hooks, etc.)
- After merging a PR that modifies dashboard components
- The backend (`cortex` bot via `arc upgrade Cortex`) and the frontend (CF Pages via `wrangler`) are deployed independently.

**Architecture:**
- `cortex` serves the REST API + WebSocket at `localhost:8766` locally, or via the CF Worker at `grove.meta-factory.ai/api/*` in production (`src/surface/mc/worker/`).
- The dashboard frontend is static HTML/JS hosted on CF Pages.
- Frontend connects to the API via URL params (`?api=`) or auto-detection.
- CF Access cookies cover dashboard + API on each TLD (`.ai`, `.dev`, `.io`) — no cross-origin cookie issue, no bypass-everyone policies (see Critical Rules).
