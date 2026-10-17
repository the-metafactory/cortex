import type { Database } from "bun:sqlite";
import { dirname, join } from "path";

import type { DegradedInfo } from "../../common/config/degraded-state";
import { loadConfig } from "./config";
import { initDatabase } from "./db/init";
import { startServer, type MissionControlViews } from "./server";
import { ProcessManager } from "./session/process-manager";
import { HookStreamPoller } from "./hooks/poller";
import type { Config } from "./types";
import type { WsClientRegistry } from "./ws/client-registry";

export interface MissionControlHandle {
  db: Database;
  port: number | null;
  wsRegistry: WsClientRegistry | null;
  stop(): Promise<void>;
}

export interface StartMissionControlOptions extends MissionControlViews {
  configPath?: string;
  dbPath: string;
  port?: number;
  headless?: boolean;
  degraded?: DegradedInfo;
}

/**
 * Boot the in-process Mission Control server. Returns a handle exposing the
 * bun:sqlite db (the cockpit refresh loop needs it), the effective listen port,
 * and an async `stop()`.
 */
export async function startMissionControl(
  opts: StartMissionControlOptions,
): Promise<MissionControlHandle> {
  const loaded = loadConfig(opts.configPath === "" ? undefined : opts.configPath);

  const config: Config = {
    ...loaded,
    port: opts.port && opts.port > 0 ? opts.port : loaded.port,
    db: { path: opts.dbPath },
    hooks: {
      ...loaded.hooks,
      cursorPath: join(dirname(opts.dbPath), "mc-hook-cursor.json"),
    },
  };

  const db = initDatabase(config.db.path);

  if (opts.headless === true) {
    let headlessPoller: HookStreamPoller | null = null;
    try {
      headlessPoller = new HookStreamPoller(db, config.hooks);
      headlessPoller.start();

      const startedPoller = headlessPoller;
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
      ...(opts.vigil ? { vigil: opts.vigil } : {}),
      ...(opts.agentPresence ? { agentPresence: opts.agentPresence } : {}),
      ...(opts.networks ? { networks: opts.networks } : {}),
      ...(opts.admissionDecider ? { admissionDecider: opts.admissionDecider } : {}),
      ...(opts.authorizer ? { authorizer: opts.authorizer } : {}),
      ...(opts.handoffView ? { handoffView: opts.handoffView } : {}),
      ...(opts.doctorView ? { doctorView: opts.doctorView } : {}),
      ...(opts.localAggregation ? { localAggregation: opts.localAggregation } : {}),
      ...(opts.sidebandUrl ? { sidebandUrl: opts.sidebandUrl } : {}),
      ...(opts.degraded ? { degraded: opts.degraded } : {}),
    });
    const { port, wsRegistry } = serverCtx;
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

    return { db, port, wsRegistry, stop };
  } catch (err) {
    hookPoller?.stop();
    serverCtx?.stop(true);
    db.close();
    throw err;
  }
}
