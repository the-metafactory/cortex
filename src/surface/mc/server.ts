/**
 * Grove Mission Control v2 — HTTP + WebSocket server.
 */

import type { Server, ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type { Config } from "./types";
import type { WsData } from "./ws/types";
import { WS_PROTOCOL_VERSION } from "./ws/types";
import { WsClientRegistry } from "./ws/client-registry";
import { generateId } from "./db/events";
import type { ApiDeps } from "./api/handlers";
import type { MaybeNotifyDeps } from "./notifications";
import {
  handleAbandonAssignment,
  handleAbandonTask,
  handleAttachTaskToIteration,
  handleCreateIteration,
  handleCreateSession,
  handleCreateTask,
  handleDetachTaskFromIteration,
  handleGetAssignmentMetrics,
  handleGetFleetMetrics,
  handleGetIteration,
  handleGithubWebhook,
  handleHandoffAssignment,
  handleImportIterationFromGithub,
  handleListAssignments,
  handleListEvents,
  handleListFocusArea,
  handleListInbox,
  handleListIterations,
  handleListTasks,
  handleListWorkingAgents,
  handlePatchIteration,
  handlePreviewTask,
  handleRequeueAssignment,
  handleSendInput,
  IMAGE_BODY_MAX_BYTES,
} from "./api/handlers";
import { handleListGitLinks } from "./api/git-links";
import { handleListAgents, type AgentPresenceView } from "./api/agents";
import { handleListRepositories } from "./api/git-repos";
import { handleListPlans } from "./api/plans";
import { handleGetPhaseDetail } from "./api/phase-detail";
import { handleGetWorkItemDetail } from "./api/work-item-detail";
import { handleListAttention } from "./api/attention";
import type { ProcessManager } from "./session/process-manager";
import type { SpawnFn } from "./session/endpoint-resolver";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const VERSION = "0.1.0";
const startTime = Date.now();

// MIG-6 cutover: the React app at dist/dashboard-v2/ is now the only
// dashboard, served at /. The legacy `dashboard/index.html` monolith
// was deleted in this cycle. `bun run build:dashboard` must run before
// booting the server — when the dist/ tree is missing the / route 404s
// instead of falling back to the legacy HTML.
//
// Path resolution is three levels above the running server.ts at
// src/surface/mc/ (the grove-v2 lift moved it down one level from
// src/mission-control/ — two `..` left it pointing at `src/dist/`,
// which never exists, so `/` 500'd on every install). When packaged,
// the resolver follows the same relative offset, but a `dist/` folder
// is still expected to sit at the project root.
const DASHBOARD_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dist",
  "dashboard-v2"
);

/**
 * File extensions the bundled React app emits as static assets. Used to
 * decide whether an unmatched root-relative path should be served from
 * `DASHBOARD_DIST/<filename>` (vs falling through to 404). Anchored
 * against the build output of `bun build … --target browser`; expand
 * here if the bundler ever emits new asset types (e.g. WASM).
 */
const DASHBOARD_ASSET_EXT = /^\/[\w.-]+\.(js|css|svg|png|jpe?g|gif|webp|ico|map|woff2?)$/;

/** Server-initiated ping interval in ms. Clients that don't respond within
 *  `idleTimeoutSec` are closed by Bun's built-in idle-timeout mechanism. */
const SERVER_PING_INTERVAL_MS = 30_000;

export interface ServerContext {
  server: Server<WsData>;
  wsRegistry: WsClientRegistry;
  /**
   * Stop the server AND clear the server-initiated ping interval.
   * Always prefer this over calling `server.stop()` directly — a raw
   * `server.stop()` leaves the setInterval firing, which keeps the event
   * loop alive (tests hang, processes don't exit cleanly).
   */
  stop: (closeActive?: boolean) => void;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  /** Seconds since startServer. */
  uptime: number;
  /** Count of currently-connected WebSocket clients. */
  wsClients: number;
}

export interface StartServerOptions {
  /**
   * ProcessManager for controlled-session spawning. Required for the REST
   * endpoints that manage CC processes. If omitted (legacy tests), any
   * REST request that tries to spawn or resolve a controlled endpoint will
   * 503. The tests that don't exercise REST can keep calling without it.
   */
  processManager?: ProcessManager;
  /**
   * Spawn override for CC children. Tests inject a `cat`-based fake; in
   * production this is left undefined and endpoint-resolver's default
   * (spawns `claude`) is used.
   */
  spawn?: SpawnFn;
  /**
   * F-11 Discord notification deps. Optional — when omitted, transitions
   * still broadcast to WS as before; only the Discord push surface is
   * skipped. See `docs/design-mc-f11-discord-notifications.md`.
   */
  notify?: MaybeNotifyDeps;
  /**
   * F-12b Decision 4 — optional `owner/repo` default for `#N` / `repo#N`
   * shorthand parsing. Source: principal's `mission-control.yaml` or
   * equivalent. When absent, shorthands fail with a clear message.
   */
  defaultGithubRepo?: string;
  /**
   * F-12b Decision 3 — gh CLI spawn override for tests. Omitted in
   * production; real `Bun.spawn(['gh', 'api', ...])` is used.
   */
  ghSpawn?: import("./adapters/github").GhSpawnFn;
  /**
   * F-17 — per-network iteration label override. Defaults to
   * `"iteration"` when absent. Plumbed through to `ApiDeps.iterationLabel`
   * which the import logic honours (per-network yaml: `github.iterationLabel`).
   */
  iterationLabel?: string;
  /**
   * F-17 — GitHub webhook HMAC secret. When omitted, the
   * `POST /api/github/webhook` route 503s — no implicit bypass. The
   * principal wires this from the same `GITHUB_WEBHOOK_SECRET` they
   * configure on the upstream `webhook-proxy`.
   */
  githubWebhookSecret?: string;
  /**
   * G-1114.B.4 — accessor for the stack-local runtime agent-presence registry
   * (its `getAgents()` read-only view), serving `GET /api/agents`.
   *
   * A GETTER (not the value) because the registry boots AFTER the MC server in
   * `cortex.ts` — the embed is started, THEN the presence registry self-
   * subscribes. Resolving lazily at request time lets the server bind before
   * the registry exists and pick it up once it does, without a boot-ordering
   * dance. Returns `null` until/unless a registry is wired (MC enabled but no
   * presence registry → the handler serves an empty list gracefully).
   */
  agentPresence?: () => AgentPresenceView | null;
}

export function startServer(
  config: Config,
  db: Database,
  options: StartServerOptions = {}
): ServerContext {
  const wsRegistry = new WsClientRegistry();
  const maxClients = config.ws.maxClients;

  const apiDeps: ApiDeps | null = options.processManager
    ? {
        processManager: options.processManager,
        wsRegistry,
        spawn: options.spawn,
        ...(options.notify ? { notify: options.notify } : {}),
        ...(options.defaultGithubRepo
          ? { defaultGithubRepo: options.defaultGithubRepo }
          : {}),
        ...(options.ghSpawn ? { ghSpawn: options.ghSpawn } : {}),
        ...(options.iterationLabel
          ? { iterationLabel: options.iterationLabel }
          : {}),
        ...(options.githubWebhookSecret
          ? { githubWebhookSecret: options.githubWebhookSecret }
          : {}),
      }
    : null;

  const server = Bun.serve<WsData>({
    port: config.port,
    // SEV-2 fix: bind to loopback only — never 0.0.0.0 without auth.
    // CLAUDE.md: "NEVER add CF Access bypass-everyone policies or disable
    // authentication on any endpoint."
    hostname: config.hostname,

    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (req.method === "GET" && url.pathname === "/ws") {
        // Connection cap — reject before upgrade when at capacity.
        if (maxClients > 0 && wsRegistry.size >= maxClients) {
          return new Response("Too many WebSocket clients", { status: 503 });
        }

        const clientId = generateId();
        const upgraded = server.upgrade(req, {
          data: { clientId },
        });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      // Health endpoint.
      // Threat model: /health exposes wsClients count — benign because the
      // server binds loopback-only (config.hostname = "127.0.0.1" by default,
      // enforced by the SEV-2 fix above). If MC is ever fronted by a reverse
      // proxy or exposed beyond loopback, either strip wsClients from this
      // response or gate /health behind auth. Principal-liveness probes should
      // only see `status` + `version`.
      if (req.method === "GET" && url.pathname === "/health") {
        const body: HealthResponse = {
          status: "ok",
          version: VERSION,
          uptime: Math.floor((Date.now() - startTime) / 1000),
          wsClients: wsRegistry.size,
        };
        return Response.json(body);
      }

      // --- REST API ---
      if (url.pathname.startsWith("/api/")) {
        // Resolve the agent-presence view lazily per request — the registry
        // may not have booted when the server started (see StartServerOptions).
        const agentPresence = options.agentPresence?.() ?? null;
        return handleApi(req, url, db, apiDeps, agentPresence);
      }

      // --- Dashboard static ---
      // Dashboard shell — React SPA at / + /index.html.
      // Bun.file is streaming and sets Content-Length + keeps the file
      // handle off the heap.
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(Bun.file(join(DASHBOARD_DIST, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // Bundled assets — the React shell references its hashed
      // js/css/etc with document-relative URLs (`./index-XXX.js`),
      // which the browser resolves to `/index-XXX.js`. Restricted to
      // a known asset-extension allowlist so unknown root paths still
      // 404 instead of leaking the dist/ tree's directory shape.
      if (req.method === "GET" && DASHBOARD_ASSET_EXT.test(url.pathname)) {
        const rel = url.pathname.slice(1);
        // Belt-and-braces against `..` slipping through — the regex
        // already excludes them but cheap to re-verify.
        if (rel.includes("..") || rel.length === 0) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(Bun.file(join(DASHBOARD_DIST, rel)));
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      // FR-6: idle-timeout acts as server-initiated dead-client detection.
      // Bun automatically closes connections with no activity within this
      // window. The server-initiated ping (below) ensures active clients
      // reset the timer even when they have no application messages to send.
      idleTimeout: config.ws.idleTimeoutSec,

      // Payload cap — prevents a single client from allocating unbounded
      // memory with oversized messages. Dashboard JSON messages are small.
      maxPayloadLength: config.ws.maxPayloadLength,

      open(ws: ServerWebSocket<WsData>) {
        wsRegistry.add(ws);
        ws.send(
          JSON.stringify({
            type: "connected",
            clientId: ws.data.clientId,
            serverVersion: VERSION,
            protocolVersion: WS_PROTOCOL_VERSION,
          })
        );
      },

      message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        const raw = typeof msg === "string" ? msg : msg.toString();

        // Parse as `unknown` first — the payload is attacker-controlled and
        // cannot be trusted to match WsClientMessage. We narrow via explicit
        // type-tag checks below.
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (_err) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
          return;
        }

        // Narrow to an object with an optional string `type` field. Anything
        // else (primitives, arrays, null) falls through to the error branch.
        const typeField =
          typeof parsed === "object" && parsed !== null && "type" in parsed
            ? parsed.type
            : undefined;

        if (typeField === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        // Client pong in response to server-initiated ping — no reply needed,
        // the message itself resets the idle timer.
        if (typeField === "pong") {
          return;
        }

        if (typeField === "subscribe") {
          const assignmentIds = (parsed as { assignmentIds?: unknown }).assignmentIds;
          // Subscription filtering is a Phase C concern — acknowledge for now.
          // The "subscribed" type is part of WsServerMessage (F-5 fix #4).
          ws.send(
            JSON.stringify({
              type: "subscribed",
              assignmentIds: Array.isArray(assignmentIds) ? assignmentIds : [],
            })
          );
          return;
        }

        ws.send(
          JSON.stringify({
            type: "error",
            message:
              typeof typeField === "string"
                ? `Unknown message type: '${typeField}'`
                : "Message missing string 'type' field",
          })
        );
      },

      close(ws: ServerWebSocket<WsData>) {
        wsRegistry.remove(ws);
      },
    },
  });

  // FR-6: server-initiated ping. Sends a JSON `{ type: "ping" }` to every
  // connected client on interval. Clients that respond (with `pong` or any
  // message) reset Bun's idle timer. Those that don't respond within
  // `idleTimeoutSec` are closed automatically by Bun.
  const pingInterval = setInterval(() => {
    wsRegistry.broadcast({ type: "ping" });
  }, SERVER_PING_INTERVAL_MS);

  const stop = (closeActive = false) => {
    clearInterval(pingInterval);
    void server.stop(closeActive);
  };

  return { server, wsRegistry, stop };
}

// ---------- REST router ----------

/**
 * Route `/api/*` requests to the appropriate handler. Kept out of the fetch
 * closure to keep that hot path compact and to let us unit-test the router.
 *
 * Dispatch rules:
 *   GET  /api/assignments                — list
 *   GET  /api/focus-area                 — blocked-only feed for dashboard §8.2
 *   GET  /api/tasks                      — task-keyed feed for dashboard §8.4 (F-8)
 *   GET  /api/working-agents             — agent-keyed feed for dashboard §8.3 (F-9)
 *   GET  /api/assignments/:id/events     — paged event feed (F-7 drill-down)
 *   POST /api/sessions                   — create controlled session
 *   POST /api/assignments/:id/input      — write turn to an active session
 *
 * Any other `/api/*` path is 404. Method mismatch is 405.
 */
async function handleApi(
  req: Request,
  url: URL,
  db: Database,
  deps: ApiDeps | null,
  agentPresence: AgentPresenceView | null
): Promise<Response> {
  const { pathname } = url;

  if (pathname === "/api/assignments") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListAssignments(db);
  }

  if (pathname === "/api/focus-area") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListFocusArea(db);
  }

  // G-1113.C.6 — GET /api/git/links?refs=… — batch task→PR/branch link lookup
  // for the dashboard's PR/branch chips.
  if (pathname === "/api/git/links") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListGitLinks(db, url);
  }

  // G-1113.C.7 — GET /api/git/repositories — repos grouped with branches/PRs/
  // releases for the software-mode Repositories panel.
  if (pathname === "/api/git/repositories") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListRepositories(db);
  }

  // G-1113.D.3 — GET /api/plans — plans with ordered phases + status tally for
  // the Plans overview surface.
  if (pathname === "/api/plans") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListPlans(db);
  }

  // G-1113.D.4 — GET /api/phases/:id — phase detail (plan + work items + linked
  // PRs) for the phase-detail surface.
  if (pathname.startsWith("/api/phases/")) {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const phaseId = decodeURIComponent(pathname.slice("/api/phases/".length));
    if (!phaseId || phaseId.includes("/")) {
      return new Response(JSON.stringify({ error: "invalid phase id" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return handleGetPhaseDetail(db, phaseId);
  }

  // G-1113.D.5 — GET /api/work-items?id=… — work-item detail (plan/phase context
  // + linked PRs with reviews). The id is a query param (not a path segment)
  // because work-item ids are `owner/repo#N` and carry `/` and `#`.
  if (pathname === "/api/work-items") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const id = url.searchParams.get("id");
    if (!id) {
      return new Response(JSON.stringify({ error: "missing id query param" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return handleGetWorkItemDetail(db, id);
  }

  // G-1113.E.3 — GET /api/attention — open attention items with deep-links.
  if (pathname === "/api/attention") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListAttention(db);
  }

  if (pathname === "/api/tasks") {
    // F-12b widens the original GET-only branch into a method router.
    //   GET  /api/tasks  — F-8 listing (existing behaviour).
    //   POST /api/tasks  — F-12b create-from-GitHub.
    if (req.method === "GET") {
      return handleListTasks(db, url);
    }
    if (req.method === "POST") {
      if (!deps) {
        return jsonError(
          "REST session endpoints are unavailable (no ProcessManager configured)",
          503
        );
      }
      const body = await parseJsonBody(req);
      if (body.error) return body.error;
      return handleCreateTask(db, deps, body.value);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  // F-12b — POST /api/tasks/preview
  // Validates + fetches + dedup-checks. No write. See
  // `docs/design-mc-f12b-add-to-queue.md` Decision 6.
  if (pathname === "/api/tasks/preview") {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return jsonError(
        "REST session endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handlePreviewTask(db, deps, body.value);
  }

  // F-12b — POST /api/tasks/:taskId/abandon (inherited from F-12 Decision 5)
  const abandonTaskMatch = /^\/api\/tasks\/([^/]+)\/abandon$/.exec(pathname);
  if (abandonTaskMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return jsonError(
        "REST session endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    const captured = abandonTaskMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const taskId = decodeURIComponent(captured);
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleAbandonTask(db, deps, taskId, body.value);
  }

  if (pathname === "/api/working-agents") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListWorkingAgents(db);
  }

  // G-1114.B.4 — GET /api/agents — stack-local runtime agent-presence snapshot
  // for the dashboard's agents panel. Registry-derived (not DB), read-only.
  // `agentPresence === null` (MC enabled but no presence registry) → empty list.
  if (pathname === "/api/agents") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListAgents(db, agentPresence);
  }

  // F-17 — principal-driven GitHub iteration import.
  //   POST /api/iterations/from-github  — gh CLI fetch + import logic
  //
  // Matched BEFORE the broader `/api/iterations/:id` regex below so the
  // literal `from-github` path doesn't get captured as an id.
  if (pathname === "/api/iterations/from-github") {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return jsonError(
        "REST iteration mutation endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleImportIterationFromGithub(db, deps, body.value);
  }

  // F-17 — webhook receiver for GitHub `issues` events. HMAC-validated,
  // dispatches to iteration-import logic. Per Decision 7 only `issues`
  // is acted on; `pull_request` / `push` / etc. are ack-and-ignore.
  if (pathname === "/api/github/webhook") {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return jsonError(
        "REST iteration mutation endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    const event = req.headers.get("x-github-event") ?? "";
    const deliveryId = req.headers.get("x-github-delivery") ?? "";
    // Webhooks legitimately carry payloads larger than the default 128 KB
    // (a parent issue body capped at 50 KB plus surrounding metadata can
    // easily land in the 200-300 KB range). Cap at 1 MB.
    //
    // Read the body via the request stream rather than `req.text()` so
    // the cap fires BEFORE we buffer the full payload into memory.
    // `req.text()` would honour Bun.serve's `maxRequestBodySize` (default
    // 128 MB), letting an unauthenticated attacker pin worker RAM with
    // concurrent multi-megabyte payloads — the HMAC verify is the only
    // auth boundary on this route and it can only fire post-buffer.
    const limited = await readBodyWithCap(req, WEBHOOK_BODY_MAX_BYTES);
    if (limited.error) return limited.error;
    return handleGithubWebhook(db, deps, limited.text, {
      signature,
      event,
      deliveryId,
    });
  }

  // F-13 / F-15 — iteration planning surface.
  //   GET  /api/iterations         — kanban list (F-13)
  //   POST /api/iterations         — create (F-15)
  //   GET  /api/iterations/:id     — detail (F-15)
  //   PATCH /api/iterations/:id    — header / state mutation (F-15)
  //   POST /api/iterations/:id/tasks       — attach existing or create+attach (F-15)
  //   DELETE /api/iterations/:id/tasks/:tid — detach (F-15)
  if (pathname === "/api/iterations") {
    if (req.method === "GET") {
      return handleListIterations(db, url);
    }
    if (req.method === "POST") {
      if (!deps) {
        return jsonError(
          "REST iteration mutation endpoints are unavailable (no ProcessManager configured)",
          503
        );
      }
      const body = await parseJsonBody(req);
      if (body.error) return body.error;
      return handleCreateIteration(db, deps, body.value);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  // F-15 — iteration tasks (attach / detach). Match before the
  // single-id GET/PATCH route so `/iterations/:id/tasks(/:tid)` doesn't
  // get swallowed by the broader regex below.
  const detachTaskMatch =
    /^\/api\/iterations\/([^/]+)\/tasks\/([^/]+)$/.exec(pathname);
  if (detachTaskMatch) {
    if (req.method !== "DELETE") {
      return methodNotAllowed(["DELETE"]);
    }
    if (!deps) {
      return jsonError(
        "REST iteration mutation endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    // Captures [1] and [2] are guaranteed by the regex's anchored groups,
    // but noUncheckedIndexedAccess types them as possibly undefined. Use
    // explicit ?? "" fallbacks rather than `!` assertions.
    const iterationId = decodeURIComponent(detachTaskMatch[1] ?? "");
    const taskId = decodeURIComponent(detachTaskMatch[2] ?? "");
    return handleDetachTaskFromIteration(db, deps, iterationId, taskId);
  }

  const attachTaskMatch =
    /^\/api\/iterations\/([^/]+)\/tasks$/.exec(pathname);
  if (attachTaskMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return jsonError(
        "REST iteration mutation endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    const iterationId = decodeURIComponent(attachTaskMatch[1] ?? "");
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleAttachTaskToIteration(db, deps, iterationId, body.value);
  }

  // GET / PATCH /api/iterations/:id
  const iterationByIdMatch = /^\/api\/iterations\/([^/]+)$/.exec(pathname);
  if (iterationByIdMatch) {
    const iterationId = decodeURIComponent(iterationByIdMatch[1] ?? "");
    if (req.method === "GET") {
      return handleGetIteration(db, iterationId);
    }
    if (req.method === "PATCH") {
      if (!deps) {
        return jsonError(
          "REST iteration mutation endpoints are unavailable (no ProcessManager configured)",
          503
        );
      }
      const body = await parseJsonBody(req);
      if (body.error) return body.error;
      return handlePatchIteration(db, deps, iterationId, body.value);
    }
    return methodNotAllowed(["GET", "PATCH"]);
  }

  if (pathname === "/api/inbox") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListInbox(db, url);
  }

  // F-18 — fleet metrics. Read-only; no deps dependency.
  if (pathname === "/api/metrics/fleet") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleGetFleetMetrics(db, url);
  }

  // F-18 — assignment-scoped metrics. Matched BEFORE the broader assignment
  // routes so the `/metrics/` prefix doesn't get captured as an id segment
  // by a later regex.
  const metricsAssignmentMatch =
    /^\/api\/metrics\/assignment\/([^/]+)$/.exec(pathname);
  if (metricsAssignmentMatch) {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const captured = metricsAssignmentMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const assignmentId = decodeURIComponent(captured);
    return handleGetAssignmentMetrics(db, assignmentId);
  }

  if (pathname === "/api/sessions") {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return jsonError(
        "REST session endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleCreateSession(db, deps, body.value);
  }

  // GET /api/assignments/:id/events
  const eventsMatch = /^\/api\/assignments\/([^/]+)\/events$/.exec(pathname);
  if (eventsMatch) {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const captured = eventsMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const assignmentId = decodeURIComponent(captured);
    return handleListEvents(db, assignmentId, url);
  }

  // F-12 — POST /api/assignments/:id/requeue
  // F-12 Decision 7 — principal_requeue (blocked → queued | failed → queued).
  const requeueMatch =
    /^\/api\/assignments\/([^/]+)\/requeue$/.exec(pathname);
  if (requeueMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return jsonError(
        "REST session endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    const captured = requeueMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const assignmentId = decodeURIComponent(captured);
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleRequeueAssignment(db, deps, assignmentId, body.value);
  }

  // F-12 — POST /api/assignments/:id/abandon
  // F-12 Decision 5 — branches on context (assignment vs task scope).
  const abandonMatch =
    /^\/api\/assignments\/([^/]+)\/abandon$/.exec(pathname);
  if (abandonMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return jsonError(
        "REST session endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    const captured = abandonMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const assignmentId = decodeURIComponent(captured);
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleAbandonAssignment(db, deps, assignmentId, body.value);
  }

  // F-12 — POST /api/assignments/:id/handoff
  // F-12 Decision 6 — cancel-and-respawn (in-flight) / new-only (failed).
  const handoffMatch =
    /^\/api\/assignments\/([^/]+)\/handoff$/.exec(pathname);
  if (handoffMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return jsonError(
        "REST session endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    const captured = handoffMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const assignmentId = decodeURIComponent(captured);
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleHandoffAssignment(db, deps, assignmentId, body.value);
  }

  // POST /api/assignments/:id/input
  const inputMatch = /^\/api\/assignments\/([^/]+)\/input$/.exec(pathname);
  if (inputMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return jsonError(
        "REST session endpoints are unavailable (no ProcessManager configured)",
        503
      );
    }
    // inputMatch[1] is the captured group — guaranteed present because the
    // regex matched; the explicit check satisfies strict noUncheckedIndexedAccess.
    const captured = inputMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const assignmentId = decodeURIComponent(captured);
    // Per-endpoint upstream cap: the image-input path legitimately carries
    // bodies up to IMAGE_BODY_MAX_BYTES (25 MB). All other endpoints keep the
    // default 128 KB text-only cap. The handler's per-image / per-body caps
    // remain authoritative for user-visible errors.
    const body = await parseJsonBody(req, { maxBytes: IMAGE_BODY_MAX_BYTES });
    if (body.error) return body.error;
    return handleSendInput(db, deps, assignmentId, body.value);
  }

  return new Response("Not Found", { status: 404 });
}

function methodNotAllowed(allow: string[]): Response {
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: {
      "content-type": "application/json",
      allow: allow.join(", "),
    },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Default upstream cap on raw JSON request body size (bytes, UTF-8).
 *
 * Defence-in-depth: prevents a client from making the server allocate an
 * arbitrarily large string in `req.text()` before per-endpoint validators
 * (e.g. `DRILL_INPUT_MAX_BYTES` = 50 KB) get a chance to reject. Sized
 * generously above the largest legitimate text-only payload so per-field
 * caps remain the authoritative bound for user-visible errors.
 *
 * Routes that legitimately carry larger bodies (e.g. the image-input
 * endpoint) override this default by passing `{ maxBytes }` to
 * `parseJsonBody`. See the `/api/assignments/:id/input` route for an
 * example (uses `IMAGE_BODY_MAX_BYTES` from api/handlers.ts).
 */
const MAX_JSON_BODY_BYTES = 128 * 1024;

/**
 * Parse a JSON request body. Returns either { value } or { error: Response }.
 *
 * @param req  Incoming request.
 * @param opts.maxBytes  Optional per-endpoint upstream cap (UTF-8 bytes).
 *                       Defaults to `MAX_JSON_BODY_BYTES` (128 KB).
 */
async function parseJsonBody(
  req: Request,
  opts?: { maxBytes?: number }
): Promise<{ value: unknown; error?: undefined } | { value?: undefined; error: Response }> {
  const cap =
    opts && typeof opts.maxBytes === "number" && opts.maxBytes > 0
      ? opts.maxBytes
      : MAX_JSON_BODY_BYTES;
  // Cheap pre-check: if the client advertises a body larger than the cap,
  // reject before allocating the text. `content-length` is advisory (may be
  // absent or wrong on chunked requests), so we re-check after reading.
  const advertised = req.headers.get("content-length");
  if (advertised !== null) {
    const n = Number(advertised);
    if (Number.isFinite(n) && n > cap) {
      return { error: jsonError("Request body exceeds the size limit.", 413) };
    }
  }
  // Empty body is allowed (becomes `null`) — handlers treat null as "no input".
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > cap) {
    return { error: jsonError("Request body exceeds the size limit.", 413) };
  }
  if (text.length === 0) {
    return { value: null };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (_err) {
    return { error: jsonError("Invalid JSON body", 400) };
  }
}

/**
 * Cap on raw GitHub webhook body size (bytes, UTF-8).
 *
 * Sized to fit a parent issue body (50 KB cap upstream) plus surrounding
 * payload metadata with comfortable headroom. Defence-in-depth above the
 * HMAC verify, since the verify is the only auth boundary on the
 * `/api/github/webhook` route.
 */
const WEBHOOK_BODY_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Read a request body up to `cap` bytes via the underlying `ReadableStream`,
 * bailing with 413 the moment cumulative bytes exceed the cap.
 *
 * Why not `req.text()`: that buffers up to Bun.serve's `maxRequestBodySize`
 * (default 128 MB) into a single allocation BEFORE the caller can check the
 * length. For unauthenticated routes (the webhook receiver runs HMAC AFTER
 * the body is in hand) that turns the cap into purely advisory memory
 * pressure — concurrent multi-megabyte payloads pin RAM regardless of the
 * route's documented limit.
 *
 * Streaming-with-truncation lets us keep the HMAC verify's preferred shape
 * (it needs the raw bytes anyway) while bounding the worst-case allocation
 * to `cap` per concurrent request.
 *
 * Returns:
 *   - `{ text }`  on success (decoded UTF-8 string of the read body).
 *   - `{ error }` on cap-exceeded (413), missing body (400), or decode
 *                  failure (400). Does not consume more than `cap` bytes
 *                  in any failure mode.
 */
async function readBodyWithCap(
  req: Request,
  cap: number
): Promise<{ text: string; error?: undefined } | { text?: undefined; error: Response }> {
  // Fast-path the cheap pre-check: if the client advertises a body larger
  // than the cap, reject before draining the stream. `content-length` is
  // advisory on chunked transfers but if it's present and over cap it's
  // an unambiguous early-out.
  const advertised = req.headers.get("content-length");
  if (advertised !== null) {
    const n = Number(advertised);
    if (Number.isFinite(n) && n > cap) {
      return { error: jsonError("webhook body exceeds 1 MB cap", 413) };
    }
  }

  const stream = req.body;
  if (stream === null) {
    // GitHub webhooks always have a body; absent body is a malformed call.
    return { error: jsonError("missing request body", 400) };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // Intentional infinite loop: `done` from the stream reader is the
    // exit condition. The "always-truthy" lint rule flags `while (true)`
    // as redundant; keep it explicit for clarity since the body has
    // multiple `break`/`continue` branches.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // value is `Uint8Array | undefined` at runtime for empty pulls;
      // TS narrows it to `Uint8Array` after `done === false` but the
      // skip-empty guard is load-bearing if the underlying reader
      // signals a no-op chunk before the next real chunk.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > cap) {
        // Cancel the underlying stream so we don't keep pulling bytes
        // we'll never read; release the lock so GC can reclaim.
        try {
          await reader.cancel();
        } catch (_err) {
          // Cancel is best-effort — the response is already decided.
        }
        return { error: jsonError("webhook body exceeds 1 MB cap", 413) };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Concatenate chunks into a single Uint8Array, then decode once.
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(buf) };
  } catch (_err) {
    // TextDecoder with `fatal: false` won't throw, but guard against it.
    return { error: jsonError("invalid UTF-8 in request body", 400) };
  }
}
