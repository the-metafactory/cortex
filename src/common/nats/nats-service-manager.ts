/**
 * #763 — `NatsServiceManager`: the launchd/systemd abstraction for the
 * nats-server service that `cortex network join`/`leave` manages.
 *
 * ## The bug this closes
 *
 * The join's nats-server service management was macOS-only. It assumed the
 * service descriptor was a launchd plist: it spliced `-c <config>` into the
 * plist `ProgramArguments` and restarted via `launchctl kickstart`. On clawbox
 * (Linux, systemd) the descriptor is a systemd **unit**, so feeding it to the
 * plist parser produced the cryptic `ProgramArguments is empty` error and the
 * `launchctl` restart was meaningless.
 *
 * ## The seam
 *
 * One small interface — {@link NatsServiceManager} — with two implementations:
 *
 *   - **launchd (macOS):** ensure the plist `ProgramArguments` carry
 *     `-c <config>` (S3's `ensureConfigArg`/`renderProgramArguments`), restart
 *     via `launchctl kickstart -k gui/<uid>/<label>` reading the plist
 *     `<key>Label</key>`. This is the EXISTING behavior, lifted here verbatim.
 *   - **systemd (Linux):** ensure the unit `[Service] ExecStart=` carries
 *     `-c <config>` (S3-sibling `ensureUnitConfigArg`), then `systemctl
 *     [--user] daemon-reload` + `systemctl [--user] restart <unit>` reading the
 *     unit's `.service` id (the systemd analogue of the plist Label). The
 *     `daemon-reload` is REQUIRED (cortex#1909): systemd caches unit files, so a
 *     rewritten `ExecStart=` does not take effect on `restart` alone — unlike
 *     `launchctl kickstart -k`, which re-reads the plist implicitly. `--user`
 *     vs system scope is chosen from the unit's on-disk location.
 *
 * {@link selectNatsServiceManager} picks the implementation by the descriptor
 * type (plist XML vs systemd unit — detected from path extension, falling back
 * to a content sniff) cross-checked against the platform, and throws a CLEAR,
 * actionable error on a mismatch (plist-on-Linux / unit-on-macOS) instead of
 * the old cryptic parser failure.
 *
 * Side effects are injected: the file I/O uses `fs`, but the process exec
 * (`launchctl`/`systemctl`) goes through an injected {@link ExecRunner} so tests
 * capture the command without spawning anything. `mutate: false` is the
 * dry-run posture — reads still hit disk, but no write and NO exec happen.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

import {
  ensureConfigArg,
  plistConfigArgPresent,
  renderProgramArguments,
} from "./nats-plist-loader";
import {
  ensureUnitConfigArg,
  systemdUnitConfigArgPresent,
  systemdUnitServiceId,
} from "./systemd-unit-loader";

// =============================================================================
// Public types
// =============================================================================

/** Result of running a service-management subprocess. */
export interface ExecResult {
  code: number;
  stderr: string;
}

/** Injected process runner — captured in tests, real `Bun.spawn` in prod. */
export type ExecRunner = (argv: string[]) => Promise<ExecResult>;

/** macOS (`darwin`) vs Linux. The only two platforms cortex's join supports. */
export type ServicePlatform = "darwin" | "linux";

/**
 * The nats-server service-management seam. Both the plist `PlistPort` and the
 * `NatsServerPort` of `network-ports.ts` are satisfied by one manager:
 * `ensureConfigLoaded`/`dropConfigArg` are the config-arg-ensure half (plist
 * `ProgramArguments` or unit `ExecStart`), and `restart` reloads the daemon.
 */
export interface NatsServiceManager {
  /** Which implementation this is — for selection assertions + logging. */
  readonly kind: "launchd" | "systemd";
  /** Ensure the descriptor loads `configPath` via `-c`. Idempotent + byte-stable. */
  ensureConfigLoaded(configPath: string): void;
  /** Remove the `-c <configPath>` arg from the descriptor (leave teardown). */
  dropConfigArg(configPath: string): void;
  /** Restart nats-server so it reloads its config. Never throws. */
  restart(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** Inputs to {@link selectNatsServiceManager}. */
export interface SelectServiceManagerOptions {
  /** Path to the service descriptor (launchd plist or systemd unit). */
  descriptorPath: string;
  /** Platform the join is running on. Defaults to `process.platform` mapping. */
  platform: ServicePlatform;
  /** `true` mutates the live descriptor + execs the restart; `false` = dry-run. */
  mutate: boolean;
  /** Injected process runner (launchctl/systemctl). */
  exec: ExecRunner;
  /** launchd `gui/<uid>` target uid (defaults to `process.getuid()`/501). */
  uid?: number;
}

// =============================================================================
// Descriptor detection
// =============================================================================

type DescriptorKind = "launchd" | "systemd";

/**
 * Detect whether `descriptorPath` is a launchd plist or a systemd unit. Path
 * extension first (`.plist` → launchd, `.service` → systemd), then a content
 * sniff for the ambiguous case (a plist `<?xml … <plist` vs a systemd
 * `[Unit]`/`[Service]` section). Returns `undefined` when neither is detectable.
 */
export function detectDescriptorKind(
  descriptorPath: string,
): DescriptorKind | undefined {
  if (/\.plist$/i.test(descriptorPath)) return "launchd";
  if (/\.service$/i.test(descriptorPath)) return "systemd";
  // Ambiguous extension — sniff the content if the file exists.
  if (!existsSync(descriptorPath)) return undefined;
  const text = readFileSync(descriptorPath, "utf-8");
  if (/<\?xml/i.test(text) && /<plist/i.test(text)) return "launchd";
  if (/^\s*\[(Unit|Service|Install)\]/m.test(text)) return "systemd";
  return undefined;
}

/** The descriptor kind a given platform expects. */
function expectedKindFor(platform: ServicePlatform): DescriptorKind {
  return platform === "darwin" ? "launchd" : "systemd";
}

// =============================================================================
// launchd implementation (existing macOS behavior, lifted verbatim)
// =============================================================================

/** Unescape the five XML predefined entities. */
function unescapeXml(v: string): string {
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Read the `ProgramArguments` <string> entries from a launchd plist. */
function readProgramArguments(plistPath: string): string[] {
  const xml = readFileSync(plistPath, "utf-8");
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (block === null) return [];
  const args: string[] = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1] ?? "")) !== null) {
    args.push(unescapeXml(m[1] ?? ""));
  }
  return args;
}

/** Splice S3's canonical rendered ProgramArguments block into the plist. */
function writeProgramArguments(plistPath: string, nextArgs: string[]): void {
  const xml = readFileSync(plistPath, "utf-8");
  const next = xml.replace(
    /[ \t]*<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/,
    renderProgramArguments(nextArgs),
  );
  writeFileSync(plistPath, next, "utf-8");
}

/**
 * Read the launchd `<key>Label</key><string>…</string>` from a plist file at
 * `plistPath`. Returns `undefined` when the file is absent or carries no Label.
 * Exported (#800) so the daemon-restart adapter can derive the launchctl target
 * from the CONFIGURED nats plist's Label rather than a slug guess.
 */
export function readPlistLabel(plistPath: string): string | undefined {
  if (!existsSync(plistPath)) return undefined;
  const xml = readFileSync(plistPath, "utf-8");
  const m = /<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(xml);
  if (m === null) return undefined;
  const label = unescapeXml(m[1] ?? "").trim();
  return label === "" ? undefined : label;
}

class LaunchdServiceManager implements NatsServiceManager {
  readonly kind = "launchd" as const;
  constructor(
    private readonly plistPath: string,
    private readonly mutate: boolean,
    private readonly exec: ExecRunner,
    private readonly uid: number,
  ) {}

  ensureConfigLoaded(configPath: string): void {
    if (!existsSync(this.plistPath)) return;
    const args = readProgramArguments(this.plistPath);
    if (plistConfigArgPresent(args, configPath)) return; // idempotent no-op
    const next = ensureConfigArg(args, configPath);
    if (!this.mutate) return;
    writeProgramArguments(this.plistPath, next);
  }

  dropConfigArg(configPath: string): void {
    if (!existsSync(this.plistPath)) return;
    const args = readProgramArguments(this.plistPath);
    const next = args.filter((a, i) => {
      if (a === "-c" || a === "--config") return false;
      if (i > 0 && (args[i - 1] === "-c" || args[i - 1] === "--config")) return false;
      if (a === `--config=${configPath}`) return false;
      return true;
    });
    if (!this.mutate) return;
    writeProgramArguments(this.plistPath, next);
  }

  async restart(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.mutate) return { ok: true }; // dry-run: touch nothing.
    if (!existsSync(this.plistPath)) {
      return { ok: false, reason: `nats-server plist not found at ${this.plistPath}` };
    }
    const label = readPlistLabel(this.plistPath);
    if (label === undefined) {
      return { ok: false, reason: `no <key>Label</key> in nats-server plist ${this.plistPath}` };
    }
    const argv = ["launchctl", "kickstart", "-k", `gui/${this.uid.toString()}/${label}`];
    // #821 item-2 — `exec` (Bun.spawn) THROWS SYNCHRONOUSLY on ENOENT (launchctl
    // not on PATH). Honour the documented "never throws" contract: a spawn
    // failure becomes a clean { ok: false }, never an uncaught escape.
    let code: number;
    let stderr: string;
    try {
      ({ code, stderr } = await this.exec(argv));
    } catch (err) {
      return {
        ok: false,
        reason: `launchctl kickstart ${label} could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (code !== 0) {
      return {
        ok: false,
        reason: `launchctl kickstart ${label} exited ${code.toString()}: ${stderr.trim()}`,
      };
    }
    return { ok: true };
  }
}

// =============================================================================
// systemd implementation (new Linux behavior)
// =============================================================================

/**
 * Decide `systemctl --user` vs system scope from the unit's on-disk location.
 * User units live under a `systemd/user/` dir (`~/.config/systemd/user/…`);
 * everything else (e.g. `/etc/systemd/system/`, `/usr/lib/systemd/system/`) is
 * a system unit. This mirrors the systemd convention: `--user` for the
 * per-user manager, plain `systemctl` for the system manager.
 */
function systemdScope(unitPath: string): "user" | "system" {
  return /(^|\/)systemd\/user\//.test(unitPath) ? "user" : "system";
}

class SystemdServiceManager implements NatsServiceManager {
  readonly kind = "systemd" as const;
  constructor(
    private readonly unitPath: string,
    private readonly mutate: boolean,
    private readonly exec: ExecRunner,
  ) {}

  ensureConfigLoaded(configPath: string): void {
    if (!existsSync(this.unitPath)) return;
    const text = readFileSync(this.unitPath, "utf-8");
    if (systemdUnitConfigArgPresent(text, configPath)) return; // idempotent no-op
    const next = ensureUnitConfigArg(text, configPath);
    if (!this.mutate) return;
    if (next === text) return; // byte-stable no-op
    writeFileSync(this.unitPath, next, "utf-8");
  }

  dropConfigArg(configPath: string): void {
    if (!existsSync(this.unitPath)) return;
    const text = readFileSync(this.unitPath, "utf-8");
    const lines = text.split("\n");
    const idx = lines.findIndex((l) => /^\s*ExecStart\s*=/.test(l));
    if (idx < 0) return;
    const line = lines[idx] ?? "";
    const eq = line.indexOf("=");
    const indent = /^(\s*)/.exec(line)?.[1] ?? "";
    const value = line.slice(eq + 1).trim();
    const prefixMatch = /^([@\-+!:]+)/.exec(value);
    const prefix = prefixMatch?.[1] ?? "";
    const argv = value.slice(prefix.length).trim().split(/\s+/).filter((t) => t.length > 0);
    const dropped = argv.filter((a, i) => {
      if (a === "-c" || a === "--config") return false;
      if (i > 0 && (argv[i - 1] === "-c" || argv[i - 1] === "--config")) return false;
      if (a === `--config=${configPath}`) return false;
      return true;
    });
    const nextLine = `${indent}ExecStart=${prefix}${dropped.join(" ")}`;
    if (nextLine === line) return; // no-op
    if (!this.mutate) return;
    lines[idx] = nextLine;
    writeFileSync(this.unitPath, lines.join("\n"), "utf-8");
  }

  async restart(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.mutate) return { ok: true }; // dry-run: touch nothing.
    if (!existsSync(this.unitPath)) {
      return { ok: false, reason: `nats-server systemd unit not found at ${this.unitPath}` };
    }
    const unitText = readFileSync(this.unitPath, "utf-8");
    const serviceId = systemdUnitServiceId(this.unitPath, unitText);
    const scope = systemdScope(this.unitPath);
    const scopeFlag = scope === "user" ? ["--user"] : [];
    const scopeLabel = scope === "user" ? "--user " : "";

    // cortex#1909 (config-cutover re-render, G-09) — `daemon-reload` BEFORE
    // `restart`. Unlike `launchctl kickstart -k`, which re-reads the plist on
    // every kick, systemd caches the unit file: a rewritten `ExecStart=`
    // (`ensureConfigLoaded` repointing `--config` to the moved canonical path)
    // does NOT take effect on `restart` alone — the manager keeps running the
    // OLD argv until `daemon-reload` reloads the unit from disk. Without this
    // the Linux config split-brain the macOS leg fixes (#763/T17) stays live:
    // the daemon restarts still pointing at the pre-move config. `daemon-reload`
    // is idempotent + cheap, so we always run it (mirroring kickstart's implicit
    // re-read) rather than tracking whether THIS call mutated the unit.
    const reloadArgv = ["systemctl", ...scopeFlag, "daemon-reload"];
    // #821 item-2 — `exec` (Bun.spawn) THROWS SYNCHRONOUSLY on ENOENT (systemctl
    // not on PATH). Honour the "never throws" contract → { ok: false }.
    try {
      const { code, stderr } = await this.exec(reloadArgv);
      if (code !== 0) {
        return {
          ok: false,
          reason: `systemctl ${scopeLabel}daemon-reload exited ${code.toString()}: ${stderr.trim()}`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason: `systemctl ${scopeLabel}daemon-reload could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const argv = ["systemctl", ...scopeFlag, "restart", serviceId];
    let code: number;
    let stderr: string;
    try {
      ({ code, stderr } = await this.exec(argv));
    } catch (err) {
      return {
        ok: false,
        reason: `systemctl ${scopeLabel}restart ${serviceId} could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (code !== 0) {
      return {
        ok: false,
        reason: `systemctl ${scopeLabel}restart ${serviceId} exited ${code.toString()}: ${stderr.trim()}`,
      };
    }
    return { ok: true };
  }
}

// =============================================================================
// Selection
// =============================================================================

/**
 * Select the {@link NatsServiceManager} for `descriptorPath` on `platform`.
 *
 * Detection: extension first (`.plist` / `.service`), content sniff as fallback.
 * The detected kind is cross-checked against the platform's expected kind; a
 * mismatch (a launchd plist on Linux, or a systemd unit on macOS) throws a
 * CLEAR error naming both the descriptor type and the platform — replacing the
 * old cryptic "ProgramArguments is empty" that a systemd unit fed to the plist
 * parser produced (#763). An UNDETECTABLE descriptor defaults to the platform's
 * expected kind (so a hand-authored descriptor with an unusual name on the
 * right platform still works).
 */
export function selectNatsServiceManager(
  opts: SelectServiceManagerOptions,
): NatsServiceManager {
  const expected = expectedKindFor(opts.platform);
  const detected = detectDescriptorKind(opts.descriptorPath);

  if (detected !== undefined && detected !== expected) {
    const platformName = opts.platform === "darwin" ? "macOS" : "Linux";
    const detectedName = detected === "launchd" ? "launchd plist" : "systemd unit";
    const expectedName = expected === "launchd" ? "launchd plist" : "systemd unit";
    throw new Error(
      `nats-server service descriptor ${JSON.stringify(opts.descriptorPath)} looks like a ${detectedName}, ` +
        `which does not match the ${platformName} platform (expected a ${expectedName}). ` +
        `On ${platformName}, set stack.nats_infra.${expected === "launchd" ? "plist_path" : "unit_path"} ` +
        `to the correct descriptor (or pass --${expected === "launchd" ? "plist" : "unit"}).`,
    );
  }

  const kind = detected ?? expected;
  const uid = opts.uid ?? process.getuid?.() ?? 501;

  if (kind === "launchd") {
    return new LaunchdServiceManager(opts.descriptorPath, opts.mutate, opts.exec, uid);
  }
  return new SystemdServiceManager(opts.descriptorPath, opts.mutate, opts.exec);
}

/** Map `process.platform` onto the supported {@link ServicePlatform} set. */
export function currentServicePlatform(): ServicePlatform {
  return process.platform === "darwin" ? "darwin" : "linux";
}

/** A real `Bun.spawn`-backed {@link ExecRunner} for production wiring. */
export const bunExecRunner: ExecRunner = async (argv) => {
  const [cmd, ...rest] = argv;
  const proc = Bun.spawn([cmd ?? "", ...rest], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { code, stderr };
};
