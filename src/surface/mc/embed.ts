/**
 * MC-I1.S1 (ADR-0005) — in-process Mission Control embed.
 *
 * Boots the Mission Control v3 server inside the cortex daemon process,
 * mirroring the standalone entrypoint's composition (`src/surface/mc/index.ts`)
 * exactly: loadConfig → initDatabase → ProcessManager → startServer →
 * HookStreamPoller.start(). `stop()` reverses index.ts's shutdown ordering.
 *
 * Embedded mode deliberately OVERRIDES `db.path`, `hooks.cursorPath`, and
 * `port`: cortex owns the per-stack db location and listen port, so the MC
 * yaml at `configPath` governs only hooks / ws / log (ADR-0005 §2). The cursor
 * lives beside the db so per-stack DBs never share a hook cursor.
 */

import type { Database } from "bun:sqlite";
import { dirname, join } from "path";

import { loadConfig } from "./config";
import { initDatabase } from "./db/init";
import { startServer } from "./server";
import { ProcessManager } from "./session/process-manager";
import { HookStreamPoller } from "./hooks/poller";
import type { Config } from "./types";
import type { WsClientRegistry } from "./ws/client-registry";
import type { AgentPresenceView } from "./api/agents";
import type { LocalAggregationProvider } from "./local-aggregation/sibling-db-reader";

export interface MissionControlHandle {
  db: Database;
  /**
   * The bound HTTP listen port, or `null` in HEADLESS mode (#1044) where no
   * server is started. Callers that build a dashboard base URL (the cockpit
   * loop, the projection deep-links) MUST tolerate `null` — a headless
   * producer stack writes its db but serves no pane.
   */
  port: number | null;
  /**
   * The live WebSocket client registry (MC-I1.S6, #848). Exposed so the bus→MC
   * projection renderer can broadcast `mc.projection` refresh signals to live
   * dashboard clients on a projected mutation — closing the S4 "projection
   * writes bypass WS fan-out" gap. The cockpit/API mutation paths reach the
   * SAME registry; the projection reuses the existing broadcast helpers.
   *
   * `null` in HEADLESS mode (#1044): no server ⇒ no clients to broadcast to.
   * The projection renderers already accept an optional/absent registry (their
   * broadcast becomes a no-op), so downstream wiring passes `?? undefined`.
   */
  wsRegistry: WsClientRegistry | null;
  stop(): Promise<void>;
}

export interface StartMissionControlOptions {
  /** Optional MC yaml supplying hooks / ws / log settings. Empty/undefined → MC defaults. */
  configPath?: string;
  /**
   * Absolute db path. cortex owns this; the hook cursor lands beside it
   * (`mc-hook-cursor.json`). ONE db per stack is required — two stacks sharing
   * an explicit `dbPath` would share (and race) both the cursor and the db.
   */
  dbPath: string;
  /** Listen port. `> 0` overrides the MC yaml's port; otherwise the yaml's port (default 8767) wins. */
  port?: number;
  /**
   * #1044 — HEADLESS mode (producer/server split). When `true`, the embed runs
   * `initDatabase` + the `HookStreamPoller` INGESTOR (the db gets populated from
   * the stack's cc-events) but SKIPS `startServer` — no HTTP/WS listener, no
   * dashboard, no ProcessManager (which only serves the API's session-control
   * endpoints, never the ingestor). The returned handle's `port` and
   * `wsRegistry` are both `null`. A lean producer stack (work/halden) uses this
   * so the pane-of-glass (#1008) can read its db without it serving a pane.
   * Default (omitted/false) → FULL mode, byte-identical to pre-#1044.
   */
  headless?: boolean;
  /**
   * G-1114.B.4 — lazy accessor for the stack-local agent-presence registry
   * view (serves `GET /api/agents`). A GETTER because the registry boots AFTER
   * the embed in `cortex.ts`; resolving per request lets the server pick the
   * registry up once it exists. Forwarded verbatim to `startServer`. Omitted →
   * the route serves an empty list.
   */
  agentPresence?: () => AgentPresenceView | null;
  /**
   * #1008 — lazy accessor for the local-stack DB-read aggregation context.
   * Forwarded verbatim to `startServer` so `/api/working-agents` + `/api/agents`
   * aggregate across the principal's LOCAL sibling stacks' MC dbs. Omitted →
   * single-db feeds. A GETTER because the sibling context is built at boot
   * AFTER the embed starts.
   */
  localAggregation?: LocalAggregationProvider;
  /**
   * P-14 U0.1 — Tier-3 sideband base URL (`config.mc.sideband`). Loopback-
   * enforced at config-parse time; forwarded verbatim to `startServer`, which
   * wires it onto `ApiDeps.sidebandUrl` so the `/api/observability/*` proxy can
   * reach the local sideband daemon. Omitted → the observability routes return
   * a structured not-available error.
   */
  sidebandUrl?: string;
}

/**
 * Boot the in-process Mission Control server. Returns a handle exposing the
 * bun:sqlite db (the cockpit refresh loop needs it), the effective listen port,
 * and an async `stop()`.
 */
// The composition (loadConfig → initDatabase → startServer) is synchronous;
// `async` is the public contract (callers `await startMissionControl(...)` and
// the returned handle's `stop()` is async). require-await has nothing to flag.
// eslint-disable-next-line @typescript-eslint/require-await
export async function startMissionControl(
  opts: StartMissionControlOptions,
): Promise<MissionControlHandle> {
  // `||` (not `??`) is intentional: an empty `configPath` must collapse to
  // `undefined` so loadConfig uses its own default-path lookup, not `""`.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const loaded = loadConfig(opts.configPath || undefined);

  // cortex owns db + cursor + port; the MC yaml governs hooks/ws/log only.
  const config: Config = {
    ...loaded,
    port: opts.port && opts.port > 0 ? opts.port : loaded.port,
    db: { path: opts.dbPath },
    hooks: {
      ...loaded.hooks,
      cursorPath: join(dirname(opts.dbPath), "mc-hook-cursor.json"),
    },
  };

  // Build incrementally so a partial-boot failure tears down exactly what was
  // acquired, in reverse. The embedding daemon's catch is non-fatal (unlike the
  // standalone index.ts, which process.exit(1)s and lets the OS reclaim), so an
  // unhandled throw here would otherwise leak the db handle — and the bound
  // socket — for the whole daemon lifetime (e.g. EADDRINUSE on a busy fixed port).
  const db = initDatabase(config.db.path);

  // #1044 — HEADLESS path: db + ingestor only, NO server. The ingestor (the
  // `HookStreamPoller`) is what populates the db from the stack's cc-events, so
  // a producer stack runs it identically to a full stack — it just doesn't
  // serve a pane. No ProcessManager (it only backs the API's session-control
  // endpoints, never the ingestor); no wsRegistry (no clients to broadcast to);
  // no port (nothing bound). Built with the same incremental-teardown discipline
  // so a poller-construction failure closes the db rather than leaking it.
  if (opts.headless === true) {
    let headlessPoller: HookStreamPoller | null = null;
    try {
      // wsRegistry omitted → the ingestor's WS broadcasts are no-ops (the poller
      // already guards every broadcast on `if (this.wsRegistry)`).
      headlessPoller = new HookStreamPoller(db, config.hooks);
      headlessPoller.start();

      const startedPoller = headlessPoller;
      // require-await: the contract is async (callers `await handle.stop()`);
      // the headless teardown has nothing to await (no server, no ProcessManager).
      // eslint-disable-next-line @typescript-eslint/require-await
      const stop = async (): Promise<void> => {
        startedPoller.stop();
        db.close();
      };
      return { db, port: null, wsRegistry: null, stop };
    } catch (err) {
      headlessPoller?.stop();
      db.close();
      throw err;
    }
  }

  let serverCtx: ReturnType<typeof startServer> | null = null;
  let hookPoller: HookStreamPoller | null = null;
  try {
    const processManager = new ProcessManager();
    serverCtx = startServer(config, db, {
      processManager,
      ...(opts.agentPresence ? { agentPresence: opts.agentPresence } : {}),
      ...(opts.localAggregation ? { localAggregation: opts.localAggregation } : {}),
      ...(opts.sidebandUrl ? { sidebandUrl: opts.sidebandUrl } : {}),
    });
    const { server, wsRegistry } = serverCtx;
    hookPoller = new HookStreamPoller(db, config.hooks, wsRegistry);
    hookPoller.start();

    const startedPoller = hookPoller;
    const boundCtx = serverCtx;
    const stop = async (): Promise<void> => {
      startedPoller.stop();
      await processManager.closeAll();
      boundCtx.stop(true);
      db.close();
    };

    // The ACTUAL bound port — when `config.port` is 0, Bun.serve assigns one;
    // callers (the cockpit refresh loop's baseUrl) need the real listen port.
    // Bun.serve guarantees a numeric `port` once started; the `?? config.port`
    // coalesce only satisfies the optional type on `Server.port`.
    return { db, port: server.port ?? config.port, wsRegistry, stop };
  } catch (err) {
    // Reverse-order teardown of whatever was constructed before the throw.
    hookPoller?.stop();
    serverCtx?.stop(true);
    db.close();
    throw err;
  }
}
