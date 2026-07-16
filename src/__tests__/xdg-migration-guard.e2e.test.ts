/**
 * XDG P5 — migration + backward-compat E2E guard (cortex#1870, EPIC #1867).
 *
 * ## What this is
 *
 * The epic's PROGRESS METER. It runs FIRST (gated only by the `{home,env}`
 * seam — arc#292 / cortex#1908) and precedes every path move. Per the v3
 * rescope + the 2026-07-12 gap-review amendment it pins INVARIANTS, not paths:
 * a test that pinned today's *paths* would be a change-detector every later
 * wave is required to break. These five invariants must stay GREEN through
 * every migration wave:
 *
 *   (i)   exactly one live process per stack PID — distinct config trees get
 *         distinct pidfiles (no cross-tree SIGTERM) and a LIVE legacy pidfile
 *         is never adopted (no two daemons under one identity).
 *   (ii)  hook-writer / relay-reader / MC-cursor resolve to a BYTE-IDENTICAL
 *         events dir (the whole hook→relay→MC pipeline shares one seam).
 *   (iii) every installed plist's ProgramArguments paths + WorkingDirectory +
 *         Std*Path parents + `--config` name EXTANT files, and (Linux) every
 *         `.service` ExecStart path is extant (G-03 widened — the relay.plist
 *         that execs `…/src/taps/cc-events/relay.ts` with KeepAlive is the
 *         fleet-crash class `--config`-only checking is blind to).
 *   (iv)  daemon-env resolution ≡ shell-env resolution (G-37): the HOME a
 *         rendered plist stamps into EnvironmentVariables agrees with the HOME
 *         the paths baked into its argv resolve under, so a daemon and the CLI
 *         never split into different trees.
 *   (v)   FRESH-ENV STRICT (Fallback Contract): a scratch $HOME with NO legacy
 *         trees + CORTEX_XDG_STRICT=1 completes config/events/pidfile
 *         resolution emitting ZERO `xdg-fallback:` lines. The fresh-install
 *         failure-class killer — an upgraded machine silently exercises the
 *         fallback net, so only a fresh strict env proves new-path resolution.
 *
 * ## CI-runnable vs real-machine
 *
 * Everything here is HERMETIC (scratch $HOME, injected dirs — never the real
 * `~/.config` / `~/.claude` / `~/Library`) so it runs on the `bun test` CI job
 * (ubuntu). But scratch-HOME tests are, by the amendment's own words,
 * "vacuously green" against a box that has live stacks the tests never see. So
 * this guard ALSO EXPOSES the real-machine doctor preflight (G-23):
 * `bun scripts/xdg-audit.ts --machine`. That command is the launchctl/plist/db
 * oracle over the ACTUAL machine; the final test shells out to it as the
 * preflight surface (informational in CI, the gate on a real fleet box).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  configArgValue,
  parsePlistProgramArguments,
  parseUnitExecStartArgs,
} from "../cli/cortex/commands/daemon-locator";
import { migrateLegacyPidFile, pidFileForIn } from "../common/pidfile";
import { eventsDir, publishedEventsDir, rawEventsDir } from "../common/events-path";
import { resolveConfigFile } from "../common/config/config-path";
import { XDG_FALLBACK_PREFIX } from "../common/xdg";

// bun accepts `todo("name")` at runtime but the bundled types want a body fn;
// this cast keeps the single-arg form type-clean (same as the C-1355 guard).
const todo = test.todo as unknown as (name: string) => void;

// ── env isolation ──────────────────────────────────────────────────────────
// The whole suite runs under `bun test` (shared process). Save/restore every
// var these invariants touch so no test leaks into another (or into the real
// suite's home-injected assertions).
const MANAGED = [
  "HOME",
  "CORTEX_CONFIG_DIR",
  "CORTEX_EVENTS_DIR",
  "CORTEX_DATA_DIR",
  "CORTEX_STATE_DIR",
  "CORTEX_XDG_STRICT",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const scratches: string[] = [];

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `x1870-${prefix}-`));
  scratches.push(d);
  return d;
}

beforeEach(() => {
  for (const v of MANAGED) savedEnv[v] = process.env[v];
});
afterEach(() => {
  for (const v of MANAGED) {
    if (savedEnv[v] === undefined) Reflect.deleteProperty(process.env, v);
    else process.env[v] = savedEnv[v];
  }
  while (scratches.length) rmSync(scratches.pop()!, { recursive: true, force: true });
});

// ── plist / unit rendering + verification helpers ───────────────────────────

const SERVICES_DIR = join(import.meta.dir, "..", "services");
const STACK_TEMPLATE = join(SERVICES_DIR, "ai.meta-factory.cortex.stack.plist");
const RELAY_TEMPLATE = join(SERVICES_DIR, "ai.meta-factory.cortex.relay.plist");

/** Substitute the shell renderer's `__TOKEN__` placeholders (plist-render.sh). */
function renderTemplate(
  templatePath: string,
  tokens: Record<string, string>,
): string {
  let xml = readFileSync(templatePath, "utf-8");
  for (const [k, v] of Object.entries(tokens)) {
    xml = xml.split(`__${k}__`).join(v);
  }
  return xml;
}

function firstString(xml: string, key: string): string | undefined {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return m?.[1];
}

interface PathVerdict {
  path: string;
  kind: "exec" | "config" | "workdir" | "stdio";
  extant: boolean;
}

/**
 * The invariant-(iii) verifier over a launchd plist: collect every filesystem
 * path the plist names and classify extant-ness.
 *   - ProgramArguments absolute paths (minus the `--config` value) → the exec /
 *     script FILE must exist (this is the relay.ts / cortex-bin class G-03).
 *   - the `--config` value → the config FILE must exist.
 *   - WorkingDirectory → the DIR must exist.
 *   - Standard{Out,Error}Path → the PARENT dir must exist (launchd creates the
 *     log file itself, but fails to spawn if its parent is absent).
 */
function verifyPlistPaths(xml: string): PathVerdict[] {
  const args = parsePlistProgramArguments(xml);
  const config = configArgValue(args);
  const out: PathVerdict[] = [];

  for (const a of args) {
    if (!a.startsWith("/")) continue; // "start", "--config" etc.
    if (a === config) continue; // handled as config below
    out.push({ path: a, kind: "exec", extant: existsSync(a) });
  }
  if (config !== undefined) {
    out.push({ path: config, kind: "config", extant: existsSync(config) });
  }
  const workdir = firstString(xml, "WorkingDirectory");
  if (workdir !== undefined) {
    out.push({ path: workdir, kind: "workdir", extant: existsSync(workdir) });
  }
  for (const key of ["StandardOutPath", "StandardErrorPath"]) {
    const p = firstString(xml, key);
    if (p !== undefined) out.push({ path: p, kind: "stdio", extant: existsSync(dirname(p)) });
  }
  return out;
}

/**
 * cortex#1909 (G-09) — the invariant-(iii) verifier over a systemd `.service`
 * unit: the Linux parallel of {@link verifyPlistPaths}. Collect every filesystem
 * path the unit's `ExecStart=` names and classify extant-ness:
 *   - ExecStart absolute-path args (minus the `--config` value) → the exec /
 *     script FILE must exist (the relay.ts / cortex-bin class G-03/G-09).
 *   - the `--config` value → the config FILE must exist (the Linux parallel of
 *     the plist `--config` check — this is what invariant (iii) previously only
 *     asserted for launchd plists).
 *   - WorkingDirectory=… → the DIR must exist.
 */
function verifyUnitPaths(unitText: string): PathVerdict[] {
  const args = parseUnitExecStartArgs(unitText);
  const config = configArgValue(args);
  const out: PathVerdict[] = [];

  for (const a of args) {
    if (!a.startsWith("/")) continue; // "start", "--config", flags
    if (a === config) continue; // handled as config below
    out.push({ path: a, kind: "exec", extant: existsSync(a) });
  }
  if (config !== undefined) {
    out.push({ path: config, kind: "config", extant: existsSync(config) });
  }
  const workdir = /^\s*WorkingDirectory\s*=\s*(.+)$/m.exec(unitText)?.[1]?.trim();
  if (workdir !== undefined && workdir !== "") {
    out.push({ path: workdir, kind: "workdir", extant: existsSync(workdir) });
  }
  return out;
}

/** Build a fully-populated scratch fleet layout + the two rendered plists. */
function renderFleet(): {
  home: string;
  cortexDir: string;
  configPath: string;
  stackPlist: string;
  relayPlist: string;
} {
  const home = scratch("home");
  const cortexDir = join(home, ".local", "share", "metafactory", "cortex");
  const slug = "work";

  // Materialize every path the templates reference so a correctly-installed
  // fleet verifies fully extant.
  // cortex#1866 (XDG wave 3): the stack plist now execs ~/.local/bin/cortex.
  // Materialize it there as the real binary, and leave ~/bin/cortex as the
  // forward-symlink → ~/.local/bin/cortex that the cutover installs and never
  // deletes (deletion is wave 6, #1904). This mirrors the post-cutover on-disk
  // shape so invariant (iii) verifies the exec path the daemon actually runs.
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  const cortexBin = join(home, ".local", "bin", "cortex");
  writeFileSync(cortexBin, "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync(cortexBin, join(home, "bin", "cortex"));
  // bun stays a system binary resolved via `command -v bun` (BUN_PATH token);
  // the cutover does not move it.
  const bunPath = join(home, "bin", "bun");
  writeFileSync(bunPath, "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(cortexDir, "src", "taps", "cc-events"), { recursive: true });
  writeFileSync(join(cortexDir, "src", "taps", "cc-events", "relay.ts"), "// relay\n");
  const configDir = join(home, ".config", "cortex", slug);
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, `${slug}.yaml`);
  writeFileSync(configPath, "principal: {}\n");
  mkdirSync(join(home, ".config", "cortex", "logs"), { recursive: true });
  mkdirSync(join(home, ".claude", "logs"), { recursive: true });
  // cortex#2097 — the stack plist's WorkingDirectory moved off the cortex
  // install repo (self-editing exposure) onto the per-stack workspace dir;
  // materialize it the same way `render_stack_plist` (plist-render.sh) does
  // — owner-only (0700) — so a correctly-installed fleet verifies fully extant.
  const workspaceDir = join(cortexDir, slug, "workspace");
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

  const tokens = {
    HOME: home,
    CORTEX_DIR: cortexDir,
    CONFIG_PATH: configPath,
    STACK_SLUG: slug,
    BUN_PATH: bunPath,
    WORKSPACE_DIR: workspaceDir,
  };
  return {
    home,
    cortexDir,
    configPath,
    stackPlist: renderTemplate(STACK_TEMPLATE, tokens),
    relayPlist: renderTemplate(RELAY_TEMPLATE, tokens),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Invariant (i) — exactly one live process per stack PID.
// ═══════════════════════════════════════════════════════════════════════════
describe("(i) exactly one live process per stack PID", () => {
  test("distinct config TREES sharing a basename get DISTINCT pidfiles (no cross-tree SIGTERM)", () => {
    const stateDir = scratch("state");
    const dirA = scratch("treeA");
    const dirB = scratch("treeB");
    const cfgA = join(dirA, "stack.yaml");
    const cfgB = join(dirB, "stack.yaml");
    writeFileSync(cfgA, "principal: {}\n");
    writeFileSync(cfgB, "principal: {}\n");

    const pidA = pidFileForIn(stateDir, cfgA);
    const pidB = pidFileForIn(stateDir, cfgB);
    // Same basename ("stack") but different full paths ⇒ different hash8 ⇒
    // different pidfile. Under the old basename-only scheme both were
    // `cortex-stack.pid`: start/stop on one hit the other's daemon (#1900).
    expect(pidA).not.toBe(pidB);
    // Stable identity: the same config path always resolves the same pidfile,
    // so start/stop/status/reload converge on ONE process.
    expect(pidFileForIn(stateDir, cfgA)).toBe(pidA);
  });

  test("a LIVE legacy pidfile is NEVER adopted (never two daemons under one identity)", () => {
    const stateDir = scratch("state");
    const cfgDir = scratch("cfg");
    const configPath = join(cfgDir, "bot.yaml");
    writeFileSync(configPath, "principal: {}\n");

    // Plant an OLD-format (no-hash) pidfile naming a LIVE process (ourselves).
    const legacy = join(stateDir, "cortex-bot.pid");
    writeFileSync(legacy, String(process.pid));

    const adopted = migrateLegacyPidFile(configPath, stateDir);
    // Liveness gate refuses: the live daemon keeps its pidfile; nothing renamed.
    expect(adopted).toBeUndefined();
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(pidFileForIn(stateDir, configPath))).toBe(false);
  });

  test("a DEAD legacy pidfile IS adopted (live fleet not orphaned mid-upgrade)", () => {
    const stateDir = scratch("state");
    const cfgDir = scratch("cfg");
    const configPath = join(cfgDir, "bot.yaml");
    writeFileSync(configPath, "principal: {}\n");

    const legacy = join(stateDir, "cortex-bot.pid");
    // A PID that is (almost certainly) dead → safe to adopt.
    writeFileSync(legacy, "999999");

    const adopted = migrateLegacyPidFile(configPath, stateDir);
    expect(adopted).toBe(legacy);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(pidFileForIn(stateDir, configPath))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant (ii) — RAW events dir byte-identical across hook / relay / MC;
// PUBLISHED split off onto the data seam (XDG wave-5 #1902).
// ═══════════════════════════════════════════════════════════════════════════
describe("(ii) hook-writer / relay-reader / MC resolve a byte-identical RAW dir; published is on the data seam", () => {
  test("CORTEX_EVENTS_DIR override ⇒ all RAW sites resolve the SAME dir regardless of home spelling", () => {
    const ev = scratch("events");
    process.env.CORTEX_EVENTS_DIR = ev;
    delete process.env.CORTEX_DATA_DIR;

    // The consumers derive home DIFFERENTLY: the hook calls rawEventsDir()
    // (no arg → process.env.HOME), MC calls with os.homedir(). With the override
    // set, home is IGNORED — so all RAW spellings agree.
    const hookRaw = rawEventsDir(); // event-logger.hook.ts spelling
    const mcRaw = rawEventsDir("/some/other/home"); // mc/config.ts spelling
    expect(hookRaw).toBe(mcRaw);
    expect(hookRaw).toBe(join(ev, "raw"));
    expect(eventsDir("/ignored")).toBe(ev);

    // XDG wave-5: published is DATA — CORTEX_EVENTS_DIR does NOT move it, and it
    // NO LONGER shares raw's root (the intended split).
    const pub = publishedEventsDir("/yet/another/home");
    expect(pub.startsWith(ev)).toBe(false);
    expect(dirname(hookRaw)).not.toBe(dirname(pub));
  });

  test("CORTEX_DATA_DIR moves published (data seam) but leaves RAW untouched", () => {
    delete process.env.CORTEX_EVENTS_DIR;
    const data = scratch("data");
    process.env.CORTEX_DATA_DIR = data;
    const home = "/fake/home";
    expect(rawEventsDir(home)).toBe(join(home, ".claude", "events", "raw"));
    expect(publishedEventsDir(home)).toBe(join(data, "events", "published"));
  });

  test("both unset ⇒ raw under ~/.claude/events, published under the metafactory data root", () => {
    delete process.env.CORTEX_EVENTS_DIR;
    delete process.env.CORTEX_DATA_DIR;
    const home = "/fake/home";
    expect(rawEventsDir(home)).toBe(join(home, ".claude", "events", "raw"));
    expect(publishedEventsDir(home)).toBe(
      join(home, ".local", "share", "metafactory", "cortex", "events", "published"),
    );
    // The split: raw and published no longer share a parent.
    expect(dirname(rawEventsDir(home))).not.toBe(dirname(publishedEventsDir(home)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant (iii) — every installed plist / unit path is extant.
// ═══════════════════════════════════════════════════════════════════════════
describe("(iii) installed plist ProgramArguments + WorkingDirectory + Std*Path + --config are extant", () => {
  test("a correctly-installed stack plist has EVERY path extant", () => {
    const { stackPlist } = renderFleet();
    const verdicts = verifyPlistPaths(stackPlist);
    // sanity: we actually exercised exec + config + workdir + stdio kinds.
    expect(new Set(verdicts.map((v) => v.kind))).toEqual(
      new Set(["exec", "config", "workdir", "stdio"]),
    );
    const missing = verdicts.filter((v) => !v.extant);
    expect(missing).toEqual([]);
  });

  test("a correctly-installed relay plist has EVERY path extant (incl. the relay.ts exec — the G-03 fleet-crash class)", () => {
    const { relayPlist, cortexDir } = renderFleet();
    const verdicts = verifyPlistPaths(relayPlist);
    // The relay carries NO --config and execs `…/src/taps/cc-events/relay.ts`
    // (pkg/repos on a real box) — the exact path `--config`-only checking is
    // blind to. It MUST be verified extant.
    const relayExec = verdicts.find((v) => v.path.endsWith("relay.ts"));
    expect(relayExec).toBeDefined();
    expect(relayExec!.kind).toBe("exec");
    expect(relayExec!.extant).toBe(true);
    expect(relayExec!.path.startsWith(cortexDir)).toBe(true);
    expect(verdicts.filter((v) => !v.extant)).toEqual([]);
  });

  test("NEGATIVE: a relay whose exec moved out from under it is FLAGGED (the crash this pins against)", () => {
    const { relayPlist } = renderFleet();
    // Simulate a wave that moved the repos tree without re-rendering the plist.
    const stale = relayPlist.replace(
      /<string>[^<]*relay\.ts<\/string>/,
      "<string>/nonexistent/pkg/repos/cortex/src/taps/cc-events/relay.ts</string>",
    );
    const verdicts = verifyPlistPaths(stale);
    const missing = verdicts.filter((v) => !v.extant);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((v) => v.path.endsWith("relay.ts"))).toBe(true);
  });

  test("(Linux) a correctly-installed .service has its ExecStart exec + --config + WorkingDirectory extant (G-09)", () => {
    const { cortexDir, configPath } = renderFleet();
    const relayTs = join(cortexDir, "src", "taps", "cc-events", "relay.ts");
    // cortex#1909 — a daemon unit carries BOTH an exec AND `--config <path>`;
    // invariant (iii) now asserts the config value extant too (the Linux
    // parallel of the plist `--config` check), not just the exec.
    const unit = [
      "[Unit]",
      "Description=cortex daemon",
      "[Service]",
      `ExecStart=/usr/bin/bun ${relayTs} start --config ${configPath}`,
      `WorkingDirectory=${cortexDir}`,
      "[Install]",
      "WantedBy=default.target",
    ].join("\n");

    const verdicts = verifyUnitPaths(unit);
    // sanity: we actually exercised exec + config + workdir kinds.
    expect(new Set(verdicts.map((v) => v.kind))).toEqual(
      new Set(["exec", "config", "workdir"]),
    );
    // The CORTEX-owned exec, the config file, and the workdir are all extant.
    // (/usr/bin/bun may be absent on CI, but it is not under cortexDir so it is
    // not among the cortex-owned exec verdicts we hard-assert.)
    const cortexOwned = verdicts.filter(
      (v) => v.kind !== "exec" || v.path.startsWith(cortexDir),
    );
    expect(cortexOwned.filter((v) => !v.extant)).toEqual([]);
    // Explicitly: the --config value is verified (the G-09 addition).
    const configVerdict = verdicts.find((v) => v.kind === "config");
    expect(configVerdict).toBeDefined();
    expect(configVerdict!.path).toBe(configPath);
    expect(configVerdict!.extant).toBe(true);
  });

  test("(Linux) NEGATIVE: a .service whose exec moved out from under it is FLAGGED (G-09)", () => {
    const { cortexDir, configPath } = renderFleet();
    const relayTs = join(cortexDir, "src", "taps", "cc-events", "relay.ts");
    const stale = [
      "[Service]",
      `ExecStart=/usr/bin/bun /nonexistent/pkg/repos/cortex/relay.ts start --config ${configPath}`,
      `WorkingDirectory=${cortexDir}`,
    ].join("\n");
    const verdicts = verifyUnitPaths(stale);
    const missing = verdicts.filter((v) => !v.extant);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((v) => v.kind === "exec" && v.path.includes("/pkg/repos/"))).toBe(true);
    // control: relay.ts under the real cortexDir would have been extant.
    expect(existsSync(relayTs)).toBe(true);
  });

  test("(Linux) NEGATIVE: a .service whose --config points at a moved/absent path is FLAGGED (the T17 split-brain, G-09)", () => {
    const { cortexDir } = renderFleet();
    const relayTs = join(cortexDir, "src", "taps", "cc-events", "relay.ts");
    const stale = [
      "[Service]",
      `ExecStart=/usr/bin/bun ${relayTs} start --config /home/ghost/.config/cortex/gone.yaml`,
    ].join("\n");
    const verdicts = verifyUnitPaths(stale);
    const configVerdict = verdicts.find((v) => v.kind === "config");
    expect(configVerdict).toBeDefined();
    expect(configVerdict!.extant).toBe(false); // FLAGGED — the config-cutover regression
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant (iv) — daemon-env ≡ shell-env (G-37).
// ═══════════════════════════════════════════════════════════════════════════
describe("(iv) daemon-env resolution ≡ shell-env resolution", () => {
  test("the plist's stamped HOME agrees with the HOME its argv paths resolve under (no split trees)", () => {
    const { stackPlist, home, configPath } = renderFleet();

    const stampedHome = firstString(stackPlist.split("<key>EnvironmentVariables</key>")[1] ?? "", "HOME");
    expect(stampedHome).toBe(home);

    // The daemon resolves $HOME-derived state under `stampedHome`; the CLI
    // resolves under the same real HOME. They must be the SAME root, else a
    // `cortex stop` from the shell targets a different tree than the daemon.
    const argvConfig = configArgValue(parsePlistProgramArguments(stackPlist));
    expect(argvConfig).toBe(configPath);
    expect(argvConfig!.startsWith(stampedHome!)).toBe(true);
    expect(firstString(stackPlist, "WorkingDirectory")).toBeDefined();
  });

  test("resolution is a pure function of env ⇒ a daemon and a CLI sharing env cannot diverge", () => {
    // Single seam: given the same override env, both sides get the same dir.
    const ev = scratch("events");
    process.env.CORTEX_EVENTS_DIR = ev;
    const asDaemon = rawEventsDir("/daemon/home");
    const asCli = rawEventsDir("/cli/home");
    expect(asDaemon).toBe(asCli); // override collapses any HOME divergence
  });

  // Forward invariant (flips live with the daemon-env stamping wave, G-37 full):
  // once the renderer stamps the resolved CORTEX_CONFIG_DIR / CORTEX_STATE_DIR /
  // CORTEX_EVENTS_DIR (and any honored $XDG_* roots) into the plist
  // EnvironmentVariables / systemd Environment=, this guard must assert each
  // stamped dir byte-equals the shell-seam resolution. Today the template stamps
  // only HOME/PATH/CORTEX_CHANNEL (asserted above); the trio is not yet stamped.
  todo(
    "(iv) G-37 full: rendered EnvironmentVariables/Environment= stamp resolved CONFIG/STATE/EVENTS dirs == shell-seam resolution",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant (v) — fresh-env strict, ZERO xdg-fallback lines (Fallback Contract).
// ═══════════════════════════════════════════════════════════════════════════
describe("(v) fresh-env strict discrimination — the fresh-install failure-class killer", () => {
  let written: string[];
  let restore: () => void;

  beforeEach(() => {
    written = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    };
    restore = () => {
      process.stderr.write = orig;
    };
  });
  afterEach(() => restore());

  function fallbackLines(): string[] {
    return written.filter((l) => l.includes(XDG_FALLBACK_PREFIX));
  }

  test("scratch $HOME, NO legacy trees, CORTEX_XDG_STRICT=1 ⇒ full resolution flow emits ZERO xdg-fallback lines", () => {
    const home = scratch("fresh-home"); // pristine — no ~/.config/{cortex,grove}
    const cfg = scratch("cfg");
    const ev = scratch("events");
    const data = scratch("data");
    const st = scratch("state");
    process.env.HOME = home;
    process.env.CORTEX_CONFIG_DIR = cfg;
    process.env.CORTEX_EVENTS_DIR = ev;
    process.env.CORTEX_DATA_DIR = data; // XDG wave-5 data seam — hermetic + strict
    process.env.CORTEX_STATE_DIR = st;
    process.env.CORTEX_XDG_STRICT = "1";

    // The resolution surface a full install→start→hook→stop drives through the
    // seams (config files, events round-trip, pidfile identity). NONE should
    // touch a legacy tree on a fresh strict env.
    for (const f of ["cli.yaml", "bot.yaml", "mission-control.yaml"]) {
      const r = resolveConfigFile(f, home);
      expect(r.source).not.toBe("grove"); // never the legacy fallback
      expect(r.path.startsWith(cfg)).toBe(true);
    }
    // RAW events round-trip through the events seam (published now on the data seam).
    mkdirSync(rawEventsDir(home), { recursive: true });
    writeFileSync(join(rawEventsDir(home), "e.jsonl"), "{}\n");
    expect(existsSync(rawEventsDir(home))).toBe(true);
    // Published resolves under the (strict, scratch) data root — no legacy touch.
    expect(publishedEventsDir(home).startsWith(data)).toBe(true);
    // Pidfile identity under the scratch state dir.
    expect(pidFileForIn(st, join(cfg, "bot.yaml")).startsWith(st)).toBe(true);

    expect(fallbackLines()).toEqual([]);
  });

  test("NEGATIVE control: strict + a legacy grove file + NO override ⇒ a fallback line IS emitted (proves strict discriminates)", () => {
    const home = scratch("legacy-home");
    // Legacy tree present, override ABSENT ⇒ the grove read-fallback fires.
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(join(home, ".config", "grove", "cli.yaml"), "legacy: true\n");
    process.env.HOME = home;
    delete process.env.CORTEX_CONFIG_DIR; // no override → grove fallback reachable
    process.env.CORTEX_XDG_STRICT = "1";

    const r = resolveConfigFile("cli.yaml", home);
    expect(r.source).toBe("grove"); // legacy fallback in effect
    const lines = fallbackLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("config");
  });

  test("the SAME legacy fallback is SILENT when NOT strict (no production noise)", () => {
    const home = scratch("legacy-home-2");
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(join(home, ".config", "grove", "cli.yaml"), "legacy: true\n");
    process.env.HOME = home;
    delete process.env.CORTEX_CONFIG_DIR;
    delete process.env.CORTEX_XDG_STRICT; // NOT strict

    const r = resolveConfigFile("cli.yaml", home);
    expect(r.source).toBe("grove"); // same fallback path…
    expect(fallbackLines()).toEqual([]); // …but byte-identical/silent
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G-23 — real-machine doctor preflight the guard EXPOSES.
// ═══════════════════════════════════════════════════════════════════════════
describe("G-23 — xdg-audit --machine doctor preflight", () => {
  test("`bun scripts/xdg-audit.ts --machine --json` runs and yields a parseable finding inventory", () => {
    const script = join(import.meta.dir, "..", "..", "scripts", "xdg-audit.ts");
    expect(existsSync(script)).toBe(true);

    // READ-ONLY on the ACTUAL machine (the amendment's launchctl/plist/db
    // oracle). In CI the runner's $HOME has no cortex fleet ⇒ ~0 findings; on a
    // real fleet box it inventories live plists/pidfiles/dangling symlinks.
    // This test is the PREFLIGHT SURFACE, not a CI gate on the count: it asserts
    // the doctor executes and returns a structured inventory, so the machine
    // guard is wired and runnable. A human/CI-on-a-real-box reads the count.
    const proc = Bun.spawnSync(["bun", script, "--machine", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    const parsed = JSON.parse(out) as { findings: unknown[]; total: number };
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(typeof parsed.total).toBe("number");
    // exit code = min(total, 99) by construction — a usable gate value.
    expect(proc.exitCode).toBe(Math.min(parsed.total, 99));
  });
});
