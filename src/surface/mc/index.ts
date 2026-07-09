/**
 * Grove Mission Control v2 — legacy standalone entry point.
 *
 * RETIRED FOR PRODUCTION (FS-8a, issue #1822). Mission Control now runs
 * IN-PROCESS inside the cortex daemon: set `mc.enabled: true` in your stack
 * config and it serves on the daemon's port, fed by the agent-presence
 * registry (`startAgentPresenceRegistry`). This standalone entry used to boot
 * a server on :8767 fed by nothing current — a blank Network view that cost a
 * principal a day before they learned the MC had moved in-process.
 *
 * The boot path below is preserved ONLY for the integration-test harness,
 * which spawns this file as a subprocess to exercise the boot failure modes.
 * The harness opts in via the `--legacy` flag or `MC_LEGACY_BOOT=1` env. Run
 * as a plain production entrypoint (no escape hatch), it prints a pointer and
 * exits non-zero instead of squatting the port with a dead server.
 *
 * Usage (test harness only): bun run src/surface/mc/index.ts --legacy
 *
 * Honors MC_CONFIG_PATH env var to override the default config location
 * (used by integration tests; production reads the daemon's stack config).
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

/**
 * The pointer shown when the legacy standalone entry is run as a production
 * entrypoint. Directs the principal to the in-process MC.
 */
const RETIRED_POINTER =
  "[mission-control] This standalone Grove MC v2 entry is retired for production.\n" +
  "[mission-control] Mission Control now runs IN-PROCESS in the cortex daemon:\n" +
  "[mission-control]   - set `mc.enabled: true` in your stack config\n" +
  "[mission-control]   - it serves on the daemon's port, fed by the agent-presence registry\n" +
  "[mission-control] See docs/design-federation-simplification.md (FS-8) for context.\n" +
  "[mission-control] Run with --legacy (or MC_LEGACY_BOOT=1) only for the integration-test harness.\n";

/**
 * True when the caller has explicitly opted into the retired standalone boot
 * via the `--legacy` argv flag or the `MC_LEGACY_BOOT` env var. This is the
 * escape hatch the integration-test harness uses; a plain production
 * invocation carries neither and is refused.
 */
function legacyBootAllowed(argv: string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes("--legacy")) return true;
  const flag = env.MC_LEGACY_BOOT;
  return flag !== undefined && flag !== "" && flag !== "0" && flag !== "false";
}

/**
 * Boot the retired standalone Mission Control server. Only reachable via the
 * escape hatch (test harness). Preserves the prior NFR contract: any boot
 * failure writes `[mission-control] FATAL: <msg>` to stderr and exits 1.
 */
function bootLegacy(): void {
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
}

// Production-entrypoint guard: only runs when this file is executed directly
// (not when imported). Importing the module — e.g. to reach `legacyBootAllowed`
// or `bootLegacy` from a test — has no side effects.
if (import.meta.main) {
  if (legacyBootAllowed(process.argv.slice(2), process.env)) {
    bootLegacy();
  } else {
    process.stderr.write(RETIRED_POINTER);
    process.exit(2);
  }
}

export { legacyBootAllowed, bootLegacy, RETIRED_POINTER };
