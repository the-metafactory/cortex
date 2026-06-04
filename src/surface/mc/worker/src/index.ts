/**
 * G-400: Grove Cloud API — Cloudflare Worker
 * Hono-based REST API backed by D1, serving the same contract as the local dashboard-api.ts.
 * Multiple principals' bots push events via POST /api/ingest; the dashboard reads from GET endpoints.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes, type AuthBindings } from "./user-auth";
import { rateLimit } from "./rate-limiter";
import { ingestRoutes } from "./routes/ingest";
import { stateRoutes } from "./routes/state";
import { repoRoutes } from "./routes/repos";
import { statsRoutes } from "./routes/stats";
import { githubRoutes } from "./routes/github";
import { adminRoutes } from "./routes/admin";
import { syncRoutes } from "./routes/sync";
import { dashboardRoutes } from "./routes/dashboard";
import { DashboardSocket } from "./dashboard-socket";

export interface Env extends AuthBindings {
  CORTEX_KEYS: KVNamespace;
  ADMIN_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_REPOS: string;
  CORS_ORIGIN: string;
  /** DO backing the dashboard WebSocket (/ws) — single global instance per stack. */
  DASHBOARD_SOCKET: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

// S-002: CORS restricted to known origins (comma-separated in env var)
app.use("*", async (c, next) => {
  const raw = c.env.CORS_ORIGIN || "*";
  const origins = raw.includes(",") ? raw.split(",").map((s) => s.trim()) : raw;
  const corsMiddleware = cors({
    origin: origins,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true, // Required for CF_Authorization cookie to be sent cross-origin
  });
  return corsMiddleware(c, next);
});

// ---------------------------------------------------------------------------
// S-003: Rate limiting by endpoint category
// ---------------------------------------------------------------------------

app.use("/api/health", rateLimit("public"));
app.use("/api/pipeline/health", rateLimit("public"));
app.use("/api/state", rateLimit("read"));
app.use("/api/dashboard", rateLimit("read"));
app.use("/api/repos/*", rateLimit("read"));
app.use("/api/stats/*", rateLimit("read"));
app.use("/api/ingest", rateLimit("write"));
app.use("/api/sync", rateLimit("write"));
app.use("/admin/*", rateLimit("admin"));
app.use("/api/auth/*", rateLimit("read"));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/api/health", (c) => {
  return c.json({ status: "ok", runtime: "cloudflare-workers", api_version: 2 });
});

// H-002: Pipeline health — cloud version (no relay, just last-event stats from D1)
app.get("/api/pipeline/health", async (c) => {
  const db = c.env.CORTEX_DB;
  const row = await db.prepare(`
    SELECT MAX(last_event_at) as last_event_at, COUNT(*) as active_sessions
    FROM sessions WHERE status = 'active'
  `).first<{ last_event_at: string | null; active_sessions: number }>();

  const lastEventAt = row?.last_event_at ?? null;
  const now = Date.now();
  const lastMs = lastEventAt ? new Date(lastEventAt).getTime() : 0;
  const ageSec = lastEventAt ? (now - lastMs) / 1000 : Infinity;

  const status = ageSec < 120 ? "green" : ageSec < 600 ? "yellow" : "red";

  return c.json({
    status,
    relay_pid: null,
    relay_alive: true, // cloud — no relay process
    last_event_at: lastEventAt,
    events_last_5m: row?.active_sessions ?? 0,
  });
});

// ---------------------------------------------------------------------------
// S-058: Same-subdomain API routing
// Dashboard and API share grove.meta-factory.ai — Worker routes /api/* and
// /admin/*, CF Pages serves everything else.
//
// CF Access setup: ONE app, ZERO bypass policies.
//   "Grove Dashboard" — grove.meta-factory.ai (all paths) → Team allow
//
// M2M traffic (GitHub webhooks, bot ingest/sync) reaches this Worker via:
//   1. Webhook proxy (grove-webhook-proxy Worker at hooks.meta-factory.ai)
//      — validates HMAC, forwards via Service Binding (Worker-to-Worker tunnel,
//      bypasses zone pipeline entirely — no CF Access needed for this path)
//   2. Bot publisher (cloud-publisher.ts) sends CF-Access-Client-Id/Secret
//      headers alongside the API key for /api/ingest and /api/sync
//      — uses CF Access Service Auth policy with "Grove Bot" service token
//
// No bypass policies exist — every request through CF Access is authenticated.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Route groups
// ---------------------------------------------------------------------------

app.route("/", ingestRoutes);
app.route("/", stateRoutes);
app.route("/", repoRoutes);
app.route("/", statsRoutes);
app.route("/", githubRoutes);
app.route("/", adminRoutes);
app.route("/", syncRoutes);
app.route("/", dashboardRoutes);
app.route("/", authRoutes);

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json({ error: "not found" }, 404);
});

// ---------------------------------------------------------------------------
// WebSocket (/ws) — handled at the module level, BEFORE Hono.
// Routing the 101 upgrade through Hono's `*` CORS middleware would clone the
// Response and drop the `webSocket` handle. So we intercept /ws here and forward
// the raw request straight to the single global DashboardSocket DO instance.
// Auth: /ws inherits the host-level CF Access app (the browser sends the
// CF_Authorization cookie on the same-origin handshake) — no code-level bypass.
// ---------------------------------------------------------------------------
const worker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const id = env.DASHBOARD_SOCKET.idFromName("global");
      return env.DASHBOARD_SOCKET.get(id).fetch(request);
    }
    return app.fetch(request, env, ctx);
  },
};

export default worker;
export { DashboardSocket };
