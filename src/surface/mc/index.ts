/**
 * Grove Mission Control v2 — entry point.
 *
 * Usage: bun run src/mission-control/index.ts
 *
 * Honors MC_CONFIG_PATH env var to override the default config location
 * (used by integration tests; production reads ~/.config/grove/mission-control.yaml).
 *
 * Boot is wrapped in try/catch to honor the spec NFR contract:
 *   - On any boot failure: write `[mission-control] FATAL: <msg>` to stderr
 *     and exit with code 1. No raw stack traces in the principal's terminal.
 */

import { loadConfig } from "./config";
import { initDatabase } from "./db/init";
import { startServer } from "./server";
import { ProcessManager } from "./session/process-manager";
import { HookStreamPoller } from "./hooks/poller";

try {
  const config = loadConfig(process.env.MC_CONFIG_PATH);
  const db = initDatabase(config.db.path);
  const processManager = new ProcessManager();
  const serverCtx = startServer(config, db, { processManager });
  const { server, wsRegistry } = serverCtx;
  const hookPoller = new HookStreamPoller(db, config.hooks, wsRegistry);

  hookPoller.start();

  process.stderr.write(
    `[mission-control] v0.1.0 listening on http://localhost:${server.port}\n` +
      `[mission-control] db: ${config.db.path}\n` +
      `[mission-control] hook poller: ${config.hooks.rawEventsDir} (${config.hooks.pollInterval}ms)\n`
  );

  const shutdown = async () => {
    process.stderr.write("[mission-control] shutting down...\n");
    hookPoller.stop();
    const killed = await processManager.closeAll();
    if (killed > 0) {
      process.stderr.write(`[mission-control] killed ${killed} managed process(es)\n`);
    }
    serverCtx.stop(true);
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
} catch (err) {
  process.stderr.write(
    `[mission-control] FATAL: ${(err as Error).message}\n`
  );
  process.exit(1);
}
