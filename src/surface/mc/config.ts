/**
 * Grove Mission Control v2 — YAML config loader with defaults.
 */

import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";
import { homedir } from "os";
import type { Config, LogLevel, CfAccessConfig, GovernanceConfig } from "./types";
import { resolveConfigFilePath } from "../../common/config/config-path";

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
  // GV-1: cortex-first, grove-fallback for the default mission-control.yaml.
  const resolvedPath =
    configPath ??
    resolveConfigFilePath("mission-control.yaml");

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

  // cortex#1410 — CF Access binding (only meaningful on a non-loopback bind).
  // Parsed strictly: `cfAccess.aud` must be a non-empty string when the block
  // is present; a malformed block throws rather than silently disabling the
  // gate on a non-loopback MC.
  const cfAccessRaw = parsed.cfAccess as Record<string, unknown> | undefined;
  let cfAccess: CfAccessConfig | undefined;
  if (cfAccessRaw !== undefined) {
    if (typeof cfAccessRaw.aud !== "string" || cfAccessRaw.aud.trim() === "") {
      throw new Error(
        `cfAccess.aud must be a non-empty string in ${resolvedPath} (the Access application audience tag)`,
      );
    }
    if (
      cfAccessRaw.teamDomain !== undefined &&
      (typeof cfAccessRaw.teamDomain !== "string" || cfAccessRaw.teamDomain.trim() === "")
    ) {
      throw new Error(
        `cfAccess.teamDomain must be a non-empty string when set in ${resolvedPath}`,
      );
    }
    cfAccess = {
      aud: cfAccessRaw.aud,
      ...(typeof cfAccessRaw.teamDomain === "string"
        ? { teamDomain: cfAccessRaw.teamDomain }
        : {}),
    };
  }

  // FND-6 — `governance.principals` authorization allowlist. Parsed strictly:
  // when the block is present, `principals` MUST be an array of non-empty
  // strings (a malformed block throws rather than silently disabling the
  // authorization binding on a mutating surface).
  const governanceRaw = parsed.governance as Record<string, unknown> | undefined;
  let governance: GovernanceConfig | undefined;
  if (governanceRaw !== undefined) {
    const rawPrincipals = governanceRaw.principals;
    if (!Array.isArray(rawPrincipals)) {
      throw new Error(
        `governance.principals must be an array of principal emails in ${resolvedPath}`,
      );
    }
    const principals: string[] = [];
    for (const entry of rawPrincipals) {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new Error(
          `governance.principals entries must be non-empty strings in ${resolvedPath}`,
        );
      }
      principals.push(entry.trim());
    }
    // FND-3 — optional step-up MFA knobs. Only `secretPath` (a string) is
    // accepted today; a malformed block throws rather than silently ignoring a
    // security-relevant override.
    const stepUpRaw: unknown = governanceRaw.stepUp;
    let stepUp: { secretPath?: string } | undefined;
    if (stepUpRaw !== undefined) {
      if (stepUpRaw === null || typeof stepUpRaw !== "object" || Array.isArray(stepUpRaw)) {
        throw new Error(`governance.stepUp must be an object in ${resolvedPath}`);
      }
      const secretPathRaw = (stepUpRaw as Record<string, unknown>).secretPath;
      if (secretPathRaw !== undefined) {
        if (typeof secretPathRaw !== "string" || secretPathRaw.trim() === "") {
          throw new Error(
            `governance.stepUp.secretPath must be a non-empty string in ${resolvedPath}`,
          );
        }
        stepUp = { secretPath: secretPathRaw.trim() };
      } else {
        stepUp = {};
      }
    }
    governance = stepUp ? { principals, stepUp } : { principals };
  }

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
    ...(cfAccess ? { cfAccess } : {}),
    ...(governance ? { governance } : {}),
  };

  return Object.freeze(config);
}
