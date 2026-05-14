/**
 * Grove Mission Control v2 — YAML config loader with defaults.
 */

import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";
import { homedir } from "os";
import type { Config, LogLevel } from "./types";

const VALID_LOG_LEVELS: ReadonlySet<LogLevel> = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);

export const DEFAULT_CONFIG: Config = {
  port: 8767,
  hostname: "127.0.0.1",
  db: {
    path: join(homedir(), ".local", "share", "grove", "mission-control.db"),
  },
  log: {
    level: "info",
  },
  hooks: {
    rawEventsDir: join(homedir(), ".claude", "events", "raw"),
    cursorPath: join(
      homedir(),
      ".local",
      "share",
      "grove",
      "mc-hook-cursor.json"
    ),
    pollInterval: 2000,
  },
  ws: {
    maxPayloadLength: 64 * 1024, // 64 KB
    idleTimeoutSec: 60,
    maxClients: 100,
  },
};

/**
 * Load config from a YAML file, merging with defaults.
 * Returns a frozen Config object.
 *
 * - If the file does not exist, returns defaults.
 * - If the file is partial, missing fields get defaults.
 * - If the file is malformed YAML, throws with a clear message.
 */
export function loadConfig(configPath?: string): Readonly<Config> {
  const resolvedPath =
    configPath ??
    join(homedir(), ".config", "grove", "mission-control.yaml");

  if (!existsSync(resolvedPath)) {
    return Object.freeze({ ...DEFAULT_CONFIG });
  }

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read config at ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = (parseYaml(raw) as Record<string, unknown> | null) ?? {};
  } catch (err) {
    throw new Error(
      `Malformed YAML in ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Defense-in-depth: parseYaml may return primitives if the file isn't a
  // mapping; the cast above narrows it, but a runtime guard catches that.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `Config at ${resolvedPath} must be a YAML mapping, got ${typeof parsed}`
    );
  }

  const db = parsed.db as Record<string, unknown> | undefined;
  const log = parsed.log as Record<string, unknown> | undefined;
  const hooks = parsed.hooks as Record<string, unknown> | undefined;
  const ws = parsed.ws as Record<string, unknown> | undefined;

  let level: LogLevel = DEFAULT_CONFIG.log.level;
  if (typeof log?.level === "string") {
    if (!VALID_LOG_LEVELS.has(log.level as LogLevel)) {
      throw new Error(
        `Invalid log.level '${log.level}' in ${resolvedPath}; allowed: ${[
          ...VALID_LOG_LEVELS,
        ].join(", ")}`
      );
    }
    level = log.level as LogLevel;
  }

  const config: Config = {
    port:
      typeof parsed.port === "number" ? parsed.port : DEFAULT_CONFIG.port,
    hostname:
      typeof parsed.hostname === "string"
        ? parsed.hostname
        : DEFAULT_CONFIG.hostname,
    db: {
      path:
        typeof db?.path === "string" ? db.path : DEFAULT_CONFIG.db.path,
    },
    log: { level },
    hooks: {
      rawEventsDir:
        typeof hooks?.rawEventsDir === "string"
          ? hooks.rawEventsDir
          : DEFAULT_CONFIG.hooks.rawEventsDir,
      cursorPath:
        typeof hooks?.cursorPath === "string"
          ? hooks.cursorPath
          : DEFAULT_CONFIG.hooks.cursorPath,
      pollInterval:
        typeof hooks?.pollInterval === "number"
          ? hooks.pollInterval
          : DEFAULT_CONFIG.hooks.pollInterval,
    },
    ws: {
      maxPayloadLength:
        typeof ws?.maxPayloadLength === "number"
          ? ws.maxPayloadLength
          : DEFAULT_CONFIG.ws.maxPayloadLength,
      idleTimeoutSec:
        typeof ws?.idleTimeoutSec === "number"
          ? ws.idleTimeoutSec
          : DEFAULT_CONFIG.ws.idleTimeoutSec,
      maxClients:
        typeof ws?.maxClients === "number"
          ? ws.maxClients
          : DEFAULT_CONFIG.ws.maxClients,
    },
  };

  return Object.freeze(config);
}
