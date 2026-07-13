#!/usr/bin/env bun
/**
 * T-4.4 + T-4.5: PAI Relay Service
 * Reads raw events, applies policy, writes published events.
 * CLI interface with start/stop/status/test commands.
 */

import { Command } from "commander";
import { join } from "path";
import { existsSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { loadPolicy } from "./lib/policy-loader";
import { processEvent } from "./lib/policy-engine";
import { EventProcessor } from "./lib/event-processor";
import { watchRawEvents } from "./lib/file-watcher";
import { RawEventSchema } from "./hooks/lib/event-types";
import { eventsDir, publishedEventsDir } from "../../common/events-path";
import { migratePublishedBufferOnTouch } from "../../common/migrate-data-dir";
import { resolvePrincipalEnv } from "./hooks/lib/principal-env";
import { NatsLink } from "../../bus/nats/connection";
import { createCcEventPublisher } from "./cc-events";
import {
  buildNatsTlsOptions,
  type MtlsMode,
  type MtlsPaths,
} from "../../common/config/transport-mtls";

// Per-command Commander option shapes. Pin the permissive `opts: any`
// default to the actual flag set so `opts.policy` etc. narrow.
interface StartOptions {
  policy: string;
  foreground?: boolean;
  natsUrl?: string;
  natsToken?: string;
  org?: string;
  stack?: string;
  originatorPrincipal?: string;
  // TC-4d (#627 Phase 4) — transport mTLS for the relay's own NatsLink.
  mtls?: string;
  tlsCert?: string;
  tlsKey?: string;
  tlsCa?: string;
}
interface TestOptions {
  policy: string;
}

// =============================================================================
// Paths
// =============================================================================

// cortex#1908: single seam for the events buffer root — honors
// CORTEX_EVENTS_DIR, else `~/.claude/events` (byte-identical when unset).
const EVENTS_DIR = eventsDir();
const RAW_DIR = join(EVENTS_DIR, "raw");
// XDG wave-5 (#1902): RAW stays under ~/.claude/events (hook-substrate boundary);
// PUBLISHED is app-private DATA and resolves under the metafactory data root.
// Pure at module load; the in-flight buffer is carried forward in `start`.
const PUBLISHED_DIR = publishedEventsDir();
const DEFAULT_POLICY = join(
  process.env.HOME ?? "~",
  ".claude",
  "relay",
  "relay-policy.yaml"
);
const PID_FILE = join(process.env.HOME ?? "~", ".claude", "relay", "relay.pid");

// =============================================================================
// JSONL Data Retention (logrotate-style)
// =============================================================================
//
// Strategy (similar to logrotate):
//   1. JSONL files older than COMPRESS_AFTER_DAYS → compressed to .jsonl.gz
//   2. Compressed archives older than DELETE_AFTER_DAYS → deleted
//
// This keeps recent files readable for debugging while compressing older
// sessions for archival. Total disk usage is bounded.

const COMPRESS_AFTER_DAYS = 3;   // Compress JSONL files older than 3 days
const DELETE_AFTER_DAYS = 30;    // Delete compressed archives older than 30 days

/**
 * Compress a JSONL file to .gz and remove the original.
 * Uses Bun's built-in gzip support.
 */
async function compressFile(filePath: string): Promise<boolean> {
  try {
    const data = Bun.file(filePath);
    const content = await data.arrayBuffer();
    const compressed = Bun.gzipSync(new Uint8Array(content));
    await Bun.write(`${filePath}.gz`, compressed);
    unlinkSync(filePath);
    return true;
  } catch (_err: unknown) {
    return false; // File may be in use or already gone
  }
}

/**
 * Run retention sweep on a directory:
 *   - JSONL files older than compressAfterDays → gzip
 *   - .gz files older than deleteAfterDays → delete
 *
 * Returns { compressed, deleted } counts.
 */
async function rotateFiles(
  dir: string,
  compressAfterDays: number,
  deleteAfterDays: number,
): Promise<{ compressed: number; deleted: number }> {
  if (!existsSync(dir)) return { compressed: 0, deleted: 0 };

  const compressCutoff = Date.now() - compressAfterDays * 24 * 60 * 60 * 1000;
  const deleteCutoff = Date.now() - deleteAfterDays * 24 * 60 * 60 * 1000;
  const files = readdirSync(dir);
  let compressed = 0;
  let deleted = 0;

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const stat = statSync(filePath);

      // Phase 1: Compress stale JSONL files
      if (file.endsWith(".jsonl") && stat.mtimeMs < compressCutoff) {
        if (await compressFile(filePath)) compressed++;
        continue;
      }

      // Phase 2: Delete old compressed archives
      if (file.endsWith(".jsonl.gz") && stat.mtimeMs < deleteCutoff) {
        unlinkSync(filePath);
        deleted++;
      }
    } catch (_err: unknown) {
      // File may have been deleted between readdir and stat — skip
    }
  }

  return { compressed, deleted };
}

/**
 * Run retention sweep on both raw and published event directories.
 */
async function runRetentionSweep(): Promise<void> {
  const raw = await rotateFiles(RAW_DIR, COMPRESS_AFTER_DAYS, DELETE_AFTER_DAYS);
  const pub = await rotateFiles(PUBLISHED_DIR, COMPRESS_AFTER_DAYS, DELETE_AFTER_DAYS);

  const totalCompressed = raw.compressed + pub.compressed;
  const totalDeleted = raw.deleted + pub.deleted;
  if (totalCompressed > 0 || totalDeleted > 0) {
    console.log(
      `cortex-relay: retention sweep — compressed ${totalCompressed} file(s), ` +
      `deleted ${totalDeleted} archive(s) (raw: ${COMPRESS_AFTER_DAYS}d→gz, ${DELETE_AFTER_DAYS}d→delete)`
    );
  }
}

// =============================================================================
// CLI
// =============================================================================

const program = new Command()
  .name("cortex-relay")
  .description("PAI event relay — filters raw events to published events")
  .version("0.1.0");

program
  .command("start")
  .description("Start the relay daemon")
  .option("--policy <path>", "Path to relay policy YAML", DEFAULT_POLICY)
  .option("--foreground", "Run in foreground (don't daemonize)")
  .option(
    "--nats-url <url>",
    "Optional NATS URL — when set, the relay publishes filtered events as Myelin envelopes on local.{principal}.{type}. Falls back to env var NATS_URL.",
  )
  .option(
    "--nats-token <token>",
    "Bearer token for NATS auth. Falls back to env var NATS_TOKEN.",
  )
  .option(
    "--org <org>",
    "Principal segment for published subjects (local.{principal}.{type}). Falls back to env var CORTEX_PRINCIPAL (legacy: CORTEX_OPERATOR, GROVE_OPERATOR) or NATS_ORG. (Flag name kept as `--org` for back-compat; the segment is the principal slug per R4 vocabulary migration.)",
  )
  .option(
    "--stack <stack>",
    "Principal stack segment for stack-aware subjects (local.{principal}.{stack}.{type}). Matches the cortex.yaml stack: block. Falls back to env var CORTEX_STACK. When omitted, relay publishes on the legacy 5-segment form.",
  )
  .option(
    "--originator-principal <did>",
    "cortex#346 / myelin#161 — DID (did:mf:<name>) stamped onto envelope.originator for every relay-lifted CC event. Attribution mode is fixed at 'adapter-resolved' (the relay maps the running CC session to the stack's myelin principal). Falls back to env var CORTEX_ORIGINATOR_PRINCIPAL. Omit to publish without an originator block (pre-#346 behaviour; receivers fall back to signed_by[0].principal).",
  )
  .option(
    "--mtls <mode>",
    "TC-4d (#627 Phase 4) — transport mTLS mode for the relay's NATS connection: off (default, plaintext) | on (offer client cert, degrade to plaintext if absent) | require (refuse non-mTLS, fail closed). Falls back to env var CORTEX_TRANSPORT_MTLS.",
  )
  .option(
    "--tls-cert <path>",
    "TC-4d — path to the PEM client certificate the relay presents. Falls back to env var CORTEX_TLS_CERT_PATH.",
  )
  .option(
    "--tls-key <path>",
    "TC-4d — path to the PEM private key for --tls-cert (chmod 600 enforced). Falls back to env var CORTEX_TLS_KEY_PATH.",
  )
  .option(
    "--tls-ca <path>",
    "TC-4d — path to the PEM CA bundle used to verify the NATS server cert (omit to use the system trust store). Falls back to env var CORTEX_TLS_CA_PATH.",
  )
  .action(async (options: StartOptions) => {
    if (!existsSync(options.policy)) {
      console.error(`Policy file not found: ${options.policy}`);
      console.error("Run the installer to create the default policy.");
      process.exit(1);
    }

    if (!existsSync(RAW_DIR)) {
      console.error(`Raw events directory not found: ${RAW_DIR}`);
      console.error("Events will be created when CORTEX_CHANNEL (legacy GROVE_CHANNEL) is set");
      // Create it so the watcher doesn't fail
      const { mkdirSync } = await import("fs");
      mkdirSync(RAW_DIR, { recursive: true, mode: 0o700 });
    }

    const policy = loadPolicy(options.policy);

    // MIG-5b: Optional NATS publishing. The relay opens its own NatsLink
    // (independent of the bot's MyelinRuntime — the relay is a separate
    // daemon). When --nats-url is absent (or env var NATS_URL unset), the
    // relay behaves identically to its pre-MIG-5b form: JSONL only, zero
    // bus emission. This matches the project-wide rule that grove must
    // stay installable without NATS configured.
    const natsUrl: string | undefined = options.natsUrl ?? process.env.NATS_URL;
    const natsToken: string | undefined =
      options.natsToken ?? process.env.NATS_TOKEN;
    // R9 (cortex#388 PR-3): the principal segment resolves through the
    // principal env-var compat shim — CORTEX_PRINCIPAL with a fallback to
    // the legacy CORTEX_OPERATOR / GROVE_OPERATOR names. The CLI flag
    // `--org` is kept for back-compat (R4 cortex#453 — wire vocabulary
    // renamed but CLI flag names are user-facing and stay one release).
    const principal: string =
      options.org ?? resolvePrincipalEnv() ?? process.env.NATS_ORG ?? "default";
    // cortex#266 — IAW A.5 stack segment for 6-segment publishes.
    const stack: string | undefined =
      options.stack ?? process.env.CORTEX_STACK ?? undefined;
    // cortex#346 — myelin#161 originator principal stamped onto every
    // relay-lifted CC envelope. Opt-in: omit to preserve pre-#346 wire
    // format (no originator block). Validation of the DID format lives
    // downstream in myelin's envelope validator — passing a malformed
    // value fails AJV on first publish, surfacing the error in stderr.
    const originatorPrincipal: string | undefined =
      options.originatorPrincipal ??
      process.env.CORTEX_ORIGINATOR_PRINCIPAL ??
      undefined;
    // cortex#275 (Sage cycle 1) — fail-fast stack validation. If the
    // principal supplied a malformed stack value (`*`, `>`, empty,
    // uppercase, etc.), reject at startup with a clear error rather
    // than letting the bad value reach `deriveNatsSubject` per-event
    // and producing a stream of stderr lines. Mirrors the same regex
    // myelin's `assertSegment` uses; inlined here so the relay doesn't
    // depend on a non-barreled internal export.
    if (stack !== undefined && !/^[a-z][a-z0-9-]{0,62}$/.test(stack)) {
      console.error(
        `cortex-relay: invalid --stack / CORTEX_STACK value ${JSON.stringify(stack)} — ` +
          `must match /^[a-z][a-z0-9-]{0,62}$/ (lowercase alphanumeric + hyphens, ` +
          `start with letter, 1–63 chars)`,
      );
      process.exit(1);
    }

    let natsLink: NatsLink | undefined;
    let onPublished: ((e: import("./hooks/lib/event-types").PublishedEvent) => void) | undefined;

    // TC-4d (#627 Phase 4) — transport-mTLS for the relay's own NatsLink
    // (token-only pre-TC-4d). Mode + cert/key/ca resolve from flags then env;
    // `off` (default) builds no tls block ⇒ plaintext, byte-identical to today.
    // Under `require`, a missing/invalid cert throws from `buildNatsTlsOptions`
    // and is caught by the existing connect try/catch — the relay then
    // continues JSONL-only (it must never crash its archival job), but it does
    // NOT publish over a plaintext bus, so the fail-closed guarantee holds.
    const mtlsModeRaw = options.mtls ?? process.env.CORTEX_TRANSPORT_MTLS ?? "off";
    if (mtlsModeRaw !== "off" && mtlsModeRaw !== "on" && mtlsModeRaw !== "require") {
      console.error(
        `cortex-relay: invalid --mtls / CORTEX_TRANSPORT_MTLS value ${JSON.stringify(mtlsModeRaw)} — must be off | on | require`,
      );
      process.exit(1);
    }
    const mtlsMode: MtlsMode = mtlsModeRaw;
    // `MtlsPaths` fields are all optional; `buildNatsTlsOptions` reads them via
    // `paths?.cert_path`, so an absent flag/env resolving to `undefined` is
    // equivalent to omitting the key. No conditional spread needed.
    const tlsPaths: MtlsPaths = {
      cert_path: options.tlsCert ?? process.env.CORTEX_TLS_CERT_PATH,
      key_path: options.tlsKey ?? process.env.CORTEX_TLS_KEY_PATH,
      ca_path: options.tlsCa ?? process.env.CORTEX_TLS_CA_PATH,
    };

    if (natsUrl) {
      try {
        const relayTls = buildNatsTlsOptions(mtlsMode, tlsPaths, {
          site: "cortex-relay",
        });
        natsLink = await NatsLink.connect({
          url: natsUrl,
          token: natsToken,
          name: "cortex-relay",
          ...(relayTls !== undefined ? { tls: relayTls } : {}),
        });
        onPublished = createCcEventPublisher({
          link: natsLink,
          principal,
          ...(stack !== undefined && { stack }),
          ...(originatorPrincipal !== undefined && { originatorPrincipal }),
        });
        const safeUrl = natsUrl.replace(/\/\/[^@/]+@/, "//***@");
        const stackSuffix = stack !== undefined ? ` stack="${stack}"` : "";
        const originatorSuffix =
          originatorPrincipal !== undefined
            ? ` originator="${originatorPrincipal}"`
            : "";
        console.log(
          `cortex-relay: nats publishing enabled — ${safeUrl} (principal="${principal}"${stackSuffix}${originatorSuffix})`,
        );
      } catch (err) {
        // Per the design rule: failed NATS startup must NOT crash the
        // relay's primary archival job. Log and continue JSONL-only.
        console.error(
          `cortex-relay: nats startup failed — continuing without bus publishing: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        natsLink = undefined;
        onPublished = undefined;
      }
    }

    const processor = new EventProcessor(policy, { onPublished });

    // Write PID file
    writeFileSync(PID_FILE, String(process.pid));

    // XDG wave-5 (#1902, guardrail A): carry the in-flight published buffer to
    // the canonical data-root location (copy-keep-source) BEFORE processing, so
    // any published-but-not-yet-consumed event survives the move and the Discord
    // consumer (now reading the canonical dir) doesn't miss it. Idempotent.
    const carriedBuf = migratePublishedBufferOnTouch();
    if (carriedBuf.carried > 0) {
      console.log(
        `cortex-relay: carried ${carriedBuf.carried} in-flight published file(s) to ${carriedBuf.dir} (XDG #1902)`,
      );
    }

    // Run retention sweep on startup (removes stale JSONL files)
    void runRetentionSweep();

    console.log("cortex-relay: starting...");
    console.log(`  Policy: ${options.policy}`);
    console.log(`  Raw:    ${RAW_DIR} (${COMPRESS_AFTER_DAYS}d→gz, ${DELETE_AFTER_DAYS}d→delete)`);
    console.log(`  Pub:    ${PUBLISHED_DIR} (${COMPRESS_AFTER_DAYS}d→gz, ${DELETE_AFTER_DAYS}d→delete)`);
    console.log(`  NATS:   ${natsLink ? "enabled" : "disabled (no --nats-url)"}`);
    console.log(`  PID:    ${process.pid}`);

    // Watch and process
    const cleanup = watchRawEvents(RAW_DIR, (rawPath) => {
      const filename = rawPath.split("/").pop() ?? rawPath;
      const publishedPath = join(PUBLISHED_DIR, filename);
      const count = processor.processFile(rawPath, publishedPath);
      if (count > 0) {
        console.log(`  Processed ${count} event(s) from ${filename}`);
      }
    });

    // Periodic re-scan (catch events that inotify might miss)
    const interval = setInterval(() => {
      if (!existsSync(RAW_DIR)) return;
      const files = readdirSync(RAW_DIR).filter((f: string) =>
        f.endsWith(".jsonl")
      );
      for (const file of files) {
        const rawPath = join(RAW_DIR, file);
        const publishedPath = join(PUBLISHED_DIR, file);
        processor.processFile(rawPath, publishedPath);
      }
    }, 5000);

    // Periodic retention sweep (every 6 hours)
    const retentionInterval = setInterval(() => {
      void runRetentionSweep();
    }, 6 * 60 * 60 * 1000);

    // Handle shutdown
    const shutdown = async () => {
      console.log("\ncortex-relay: shutting down...");
      cleanup();
      clearInterval(interval);
      clearInterval(retentionInterval);
      if (natsLink) {
        try {
          await natsLink.close();
        } catch (err) {
          console.error(
            `cortex-relay: nats close error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
      process.exit(0);
    };

    process.on("SIGINT", () => { shutdown().catch(() => process.exit(1)); });
    process.on("SIGTERM", () => { shutdown().catch(() => process.exit(1)); });

    console.log("cortex-relay: daemon started (Ctrl+C to stop)");
  });

program
  .command("stop")
  .description("Stop the relay daemon")
  .action(() => {
    if (!existsSync(PID_FILE)) {
      console.log("cortex-relay: not running (no PID file)");
      return;
    }

    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(pid, "SIGTERM");
      unlinkSync(PID_FILE);
      console.log(`cortex-relay: stopped (PID ${pid})`);
    } catch {
      console.log(`cortex-relay: process ${pid} not found, cleaning up PID file`);
      unlinkSync(PID_FILE);
    }
  });

program
  .command("status")
  .description("Check relay status")
  .action(() => {
    if (!existsSync(PID_FILE)) {
      console.log("cortex-relay: not running");
      return;
    }

    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(pid, 0); // Check if process exists
      console.log(`cortex-relay: running (PID ${pid})`);
    } catch {
      console.log("cortex-relay: stale PID file (not running)");
      unlinkSync(PID_FILE);
    }
  });

program
  .command("test <event-json>")
  .description("Test policy against an event JSON file or string")
  .option("--policy <path>", "Path to relay policy YAML", DEFAULT_POLICY)
  .action((eventJson: string, options: TestOptions) => {
    const policy = loadPolicy(options.policy);

    let raw: unknown;
    if (existsSync(eventJson)) {
      raw = JSON.parse(readFileSync(eventJson, "utf-8"));
    } else {
      raw = JSON.parse(eventJson);
    }

    const parsed = RawEventSchema.parse(raw);
    const result = processEvent(parsed, policy);

    if (result) {
      console.log("✓ Event PASSES policy:");
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("✗ Event DROPPED by policy");
    }
  });

program.parse();
