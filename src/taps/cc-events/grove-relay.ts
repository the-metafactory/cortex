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
import { NatsLink } from "../../bus/nats/connection";
import { createCcEventPublisher } from "./cc-events";

// =============================================================================
// Paths
// =============================================================================

const EVENTS_DIR = join(process.env.HOME ?? "~", ".claude", "events");
const RAW_DIR = join(EVENTS_DIR, "raw");
const PUBLISHED_DIR = join(EVENTS_DIR, "published");
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
      `grove-relay: retention sweep — compressed ${totalCompressed} file(s), ` +
      `deleted ${totalDeleted} archive(s) (raw: ${COMPRESS_AFTER_DAYS}d→gz, ${DELETE_AFTER_DAYS}d→delete)`
    );
  }
}

// =============================================================================
// CLI
// =============================================================================

const program = new Command()
  .name("grove-relay")
  .description("PAI event relay — filters raw events to published events")
  .version("0.1.0");

program
  .command("start")
  .description("Start the relay daemon")
  .option("--policy <path>", "Path to relay policy YAML", DEFAULT_POLICY)
  .option("--foreground", "Run in foreground (don't daemonize)")
  .option(
    "--nats-url <url>",
    "Optional NATS URL — when set, the relay publishes filtered events as Myelin envelopes on local.{org}.{type}. Falls back to env var NATS_URL.",
  )
  .option(
    "--nats-token <token>",
    "Bearer token for NATS auth. Falls back to env var NATS_TOKEN.",
  )
  .option(
    "--org <org>",
    "Operator/org segment for published subjects (local.{org}.{type}). Falls back to env var GROVE_OPERATOR or NATS_ORG.",
  )
  .action(async (options) => {
    if (!existsSync(options.policy)) {
      console.error(`Policy file not found: ${options.policy}`);
      console.error("Run grove install.sh to create default policy");
      process.exit(1);
    }

    if (!existsSync(RAW_DIR)) {
      console.error(`Raw events directory not found: ${RAW_DIR}`);
      console.error("Events will be created when GROVE_CHANNEL is set");
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
    const org: string =
      options.org ?? process.env.GROVE_OPERATOR ?? process.env.NATS_ORG ?? "default";

    let natsLink: NatsLink | undefined;
    let onPublished: ((e: import("./hooks/lib/event-types").PublishedEvent) => void) | undefined;

    if (natsUrl) {
      try {
        natsLink = await NatsLink.connect({
          url: natsUrl,
          token: natsToken,
          name: "grove-relay",
        });
        onPublished = createCcEventPublisher({
          link: natsLink,
          org,
        });
        const safeUrl = natsUrl.replace(/\/\/[^@/]+@/, "//***@");
        console.log(
          `grove-relay: nats publishing enabled — ${safeUrl} (org="${org}")`,
        );
      } catch (err) {
        // Per the design rule: failed NATS startup must NOT crash the
        // relay's primary archival job. Log and continue JSONL-only.
        console.error(
          `grove-relay: nats startup failed — continuing without bus publishing: ${
            err instanceof Error ? err.message : err
          }`,
        );
        natsLink = undefined;
        onPublished = undefined;
      }
    }

    const processor = new EventProcessor(policy, { onPublished });

    // Write PID file
    writeFileSync(PID_FILE, String(process.pid));

    // Run retention sweep on startup (removes stale JSONL files)
    runRetentionSweep();

    console.log("grove-relay: starting...");
    console.log(`  Policy: ${options.policy}`);
    console.log(`  Raw:    ${RAW_DIR} (${COMPRESS_AFTER_DAYS}d→gz, ${DELETE_AFTER_DAYS}d→delete)`);
    console.log(`  Pub:    ${PUBLISHED_DIR} (${COMPRESS_AFTER_DAYS}d→gz, ${DELETE_AFTER_DAYS}d→delete)`);
    console.log(`  NATS:   ${natsLink ? "enabled" : "disabled (no --nats-url)"}`);
    console.log(`  PID:    ${process.pid}`);

    // Watch and process
    const cleanup = watchRawEvents(RAW_DIR, (rawPath) => {
      const filename = rawPath.split("/").pop()!;
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
    const retentionInterval = setInterval(runRetentionSweep, 6 * 60 * 60 * 1000);

    // Handle shutdown
    const shutdown = async () => {
      console.log("\ngrove-relay: shutting down...");
      cleanup();
      clearInterval(interval);
      clearInterval(retentionInterval);
      if (natsLink) {
        try {
          await natsLink.close();
        } catch (err) {
          console.error(
            `grove-relay: nats close error: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
      process.exit(0);
    };

    process.on("SIGINT", () => { shutdown().catch(() => process.exit(1)); });
    process.on("SIGTERM", () => { shutdown().catch(() => process.exit(1)); });

    console.log("grove-relay: daemon started (Ctrl+C to stop)");
  });

program
  .command("stop")
  .description("Stop the relay daemon")
  .action(() => {
    if (!existsSync(PID_FILE)) {
      console.log("grove-relay: not running (no PID file)");
      return;
    }

    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(pid, "SIGTERM");
      unlinkSync(PID_FILE);
      console.log(`grove-relay: stopped (PID ${pid})`);
    } catch {
      console.log(`grove-relay: process ${pid} not found, cleaning up PID file`);
      unlinkSync(PID_FILE);
    }
  });

program
  .command("status")
  .description("Check relay status")
  .action(() => {
    if (!existsSync(PID_FILE)) {
      console.log("grove-relay: not running");
      return;
    }

    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(pid, 0); // Check if process exists
      console.log(`grove-relay: running (PID ${pid})`);
    } catch {
      console.log("grove-relay: stale PID file (not running)");
      unlinkSync(PID_FILE);
    }
  });

program
  .command("test <event-json>")
  .description("Test policy against an event JSON file or string")
  .option("--policy <path>", "Path to relay policy YAML", DEFAULT_POLICY)
  .action((eventJson, options) => {
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
