/**
 * cortex#2533 — PURE pre-flight helpers for `cortex network make-live`, run
 * BEFORE the operator-mode bootstrap mutates anything:
 *
 * ## 1. The `$G` JetStream store (the canary that can never pass)
 *
 * Converting an anonymous (`$G`) bus to operator-mode leaves its
 * `<store_dir>/jetstream/$G` account store on disk. The operator-mode server
 * cannot recover those streams, so `/healthz` answers 503 ("JetStream stream
 * '$G > <name>' could not be recovered") for as long as the store exists — the
 * canary reads that as unhealthy and rolls back, every time. make-live refuses
 * by default and, with `--move-g-store`, moves the store ASIDE (never deletes
 * it) while nats-server is stopped.
 *
 * The move target is a sibling of the `jetstream/` dir, NOT of `$G` itself:
 * the operator-mode server walks `<store_dir>/jetstream/` and treats every
 * subdirectory as an account, so a renamed `jetstream/$G.<ts>` still fails
 * `/healthz` ("JetStream account '$G.<ts>' could not be resolved" — verified
 * against nats-server 2.14). `<store_dir>/G-moved-aside-<ts>` stays on the same
 * filesystem (the rename is atomic) and outside the account scan.
 *
 * ## 2. The rollback snapshot boot-test
 *
 * `nats-server -t` does NOT resolve a leaf remote's `account:` against the
 * accounts the server defines — a snapshot carrying such a remote passes `-t`
 * and then refuses to boot ("cannot find local account … specified in leafnode
 * remote"). The canary restores that snapshot on rollback, so an unbootable
 * snapshot turns a failed canary into a DOWN bus. make-live boots the snapshot
 * on a throwaway copy first. {@link renderBootTestConfig} produces that copy:
 * every listener on a random loopback port, every outbound URL (leaf remotes,
 * routes, gateways) pointed at a dead loopback port, the store/resolver dirs in
 * a scratch dir, and the pid/ports/log files dropped — while KEEPING every
 * `account:` line and account definition, so the check that actually fails at
 * boot still runs.
 *
 * Everything here is text in / text out. The fs walk, the move and the process
 * spawn live in `network-make-live-adapters.ts`.
 */

import { join } from "path";

import { stripConfigComments, type ConfigFileReader } from "./network-bus-safety";

// =============================================================================
// Shared value grammar
// =============================================================================

/** A nats config scalar: double-quoted, single-quoted, or a bare token. */
const VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s,}\]]+)`;

/**
 * `key: value` / `key = value` / `key value` for `key`, as a global regex. The
 * `(?!//)` keeps a URL scheme (`URL(http://…)` in a resolver) from reading as
 * an `http:` key.
 */
function keyValueRe(key: string): RegExp {
  return new RegExp(String.raw`\b(${key})(?:[ \t]*[:=](?!\/\/)[ \t]*|[ \t]+)(${VALUE})`, "g");
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// =============================================================================
// Include inlining
// =============================================================================

/**
 * `include "file"`, `include 'file'` or `include file`. nats-server resolves a
 * relative include against the including file's directory.
 */
const INCLUDE_LINE_RE = /^[ \t]*include[ \t]+(?:"([^"]+)"|'([^']+)'|(\S+))[ \t;]*$/gm;

/**
 * Inline every `include` of `rootText` (the root file's bytes, which may be a
 * SNAPSHOT rather than what is on disk now) recursively, so the result is one
 * self-contained config. nats-server's `include` is textual inclusion at that
 * position, so the inlined text parses the same way. Comments are stripped (the
 * result only feeds a throwaway boot-test copy).
 *
 * A missing include or an include cycle is a `{ ok: false }`: nats-server would
 * refuse to boot on it too, so the snapshot really is unbootable.
 */
export function inlineConfigIncludes(
  rootPath: string,
  rootText: string,
  io: ConfigFileReader,
): { ok: true; text: string } | { ok: false; reason: string } {
  const visit = (
    path: string,
    text: string,
    stack: string[],
  ): { ok: true; text: string } | { ok: false; reason: string } => {
    const dir = io.dirname(path);
    const stripped = stripConfigComments(text);
    let failure: string | undefined;
    const out = stripped.replace(INCLUDE_LINE_RE, (_line, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
      if (failure !== undefined) return "";
      const target = dq ?? sq ?? bare ?? "";
      const resolved = target.startsWith("/") ? target : io.join(dir, target);
      if (stack.includes(resolved)) {
        failure = `include cycle: ${[...stack, resolved].join(" → ")}`;
        return "";
      }
      const included = io.read(resolved);
      if (included === undefined) {
        failure = `${path} includes ${resolved}, which does not exist or cannot be read`;
        return "";
      }
      const inner = visit(resolved, included, [...stack, resolved]);
      if (!inner.ok) {
        failure = inner.reason;
        return "";
      }
      return inner.text;
    });
    return failure === undefined ? { ok: true, text: out } : { ok: false, reason: failure };
  };
  return visit(rootPath, rootText, [rootPath]);
}

// =============================================================================
// JetStream store_dir
// =============================================================================

/** What a config declares about JetStream storage. */
export type JetStreamStoreDecl =
  | { jetstream: false }
  /** `storeDir` undefined ⇒ JetStream on with nats-server's own default dir. */
  | { jetstream: true; storeDir: string | undefined };

/**
 * Parse the JetStream declaration out of a (fully inlined) nats config: a
 * `jetstream { … }` block or a `jetstream: enabled|true|on|yes` shorthand turns
 * it on; `store_dir` names the store. `jetstream: disabled|false|off|no` and no
 * `jetstream` key at all both mean off.
 */
export function parseJetStreamStoreDecl(configText: string): JetStreamStoreDecl {
  const text = stripConfigComments(configText);
  const block = /^[ \t]*jetstream[ \t]*[:=]?[ \t]*\{/m.test(text);
  const shorthand = /^[ \t]*jetstream[ \t]*[:=][ \t]*["']?(enabled|enable|true|on|yes)["']?[ \t]*$/im.test(text);
  if (!block && !shorthand) return { jetstream: false };
  const m = keyValueRe("store_dir").exec(text);
  const storeDir = m?.[2] !== undefined ? unquote(m[2]) : undefined;
  return { jetstream: true, storeDir: storeDir === "" ? undefined : storeDir };
}

// =============================================================================
// $G store reporting + move target
// =============================================================================

/** One stream directory found under `<store_dir>/jetstream/$G/streams/`. */
export interface GStoreStream {
  name: string;
  /** Total bytes on disk, or undefined when the size could not be read. */
  bytes: number | undefined;
}

/** Human-readable byte count (`0 B`, `12.3 KiB`, `4.0 MiB`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit] ?? "TiB"}`;
}

/** `ORDERS (12.3 KiB), EVENTS (0 B)` — or a note when the store holds no stream dirs. */
export function describeGStoreStreams(streams: readonly GStoreStream[]): string {
  if (streams.length === 0) return "no stream directories";
  return streams
    .map((s) => `${s.name} (${s.bytes === undefined ? "size unknown" : formatBytes(s.bytes)})`)
    .join(", ");
}

/**
 * Where `--move-g-store` puts the `$G` store: `<store_dir>/G-moved-aside-<stamp>`
 * — beside `jetstream/`, never inside it (see the module doc for why).
 */
export function gStoreMoveTarget(storeDir: string, stamp: string): string {
  return join(storeDir, `G-moved-aside-${stamp}`);
}

// =============================================================================
// Boot-test config render
// =============================================================================

export interface BootTestRenderOptions {
  /** Loopback port the throwaway server's HTTP monitor binds (the "is it up" probe). */
  monitorPort: number;
  /** A loopback port nothing listens on — every outbound URL is pointed here. */
  deadPort: number;
  /** Scratch dir owning the throwaway store + resolver dirs. */
  scratchDir: string;
}

export interface BootTestConfig {
  /** The throwaway config text. */
  conf: string;
  /**
   * Extra nats-server args. `-sd <scratch>/store` when the config declares no
   * `store_dir` of its own — otherwise a `jetstream: enabled` throwaway would
   * share the live server's default store. (Passing `-sd` when the config ALSO
   * declares `store_dir` is a nats-server "Duplicate 'store_dir'" error, so it
   * is one or the other.)
   */
  args: string[];
}

/** Monitor, profiling, pid/ports/log directives — dropped from the throwaway copy. */
const DROPPED_KEYS = [
  "http",
  "https",
  "http_port",
  "https_port",
  "monitor_port",
  "http_base_path",
  "prof_port",
  "pid_file",
  "ports_file_dir",
  "log_file",
  "syslog",
  "remote_syslog",
  "logfile_size_limit",
  "logfile_max_num",
];

/**
 * Render a throwaway boot-test copy of a fully inlined nats config (see
 * {@link inlineConfigIncludes}). Rewrites:
 *   - every `nats-leaf|nats-route|nats|tls|ws|wss` URL → `<scheme>://127.0.0.1:<deadPort>`
 *     (the copy must never dial the real hub, a route peer or a gateway);
 *   - every `listen` → `"127.0.0.1:-1"`, every `port` → `-1`, every `host` →
 *     `"127.0.0.1"` (random loopback ports for client/leaf/cluster/gateway/
 *     websocket/mqtt listeners — no clash with the live server);
 *   - `store_dir` → `<scratch>/store`, resolver `dir` → `<scratch>/resolver`;
 *   - monitor/profiling/pid/ports/log directives dropped, then one
 *     `http: "127.0.0.1:<monitorPort>"` appended.
 * Account definitions, `operator`/`resolver_preload`, and every leaf remote's
 * `account:` line are left as they are — those are what the boot test is for.
 */
export function renderBootTestConfig(flatText: string, opts: BootTestRenderOptions): BootTestConfig {
  const scratchStore = join(opts.scratchDir, "store");
  const scratchResolver = join(opts.scratchDir, "resolver");
  let text = stripConfigComments(flatText);

  text = text.replace(
    /\b(nats-leaf|nats-route|nats|tls|wss|ws):\/\/[^\s"',\]}]+/g,
    (_m, scheme: string) => `${scheme}://127.0.0.1:${opts.deadPort.toString()}`,
  );
  text = text.replace(keyValueRe("listen"), (_m, key: string) => `${key}: "127.0.0.1:-1"`);
  text = text.replace(keyValueRe("port"), (_m, key: string) => `${key}: -1`);
  text = text.replace(keyValueRe("host"), (_m, key: string) => `${key}: "127.0.0.1"`);

  const storeDirRewritten = keyValueRe("store_dir").test(text);
  text = text.replace(keyValueRe("store_dir"), (_m, key: string) => `${key}: "${scratchStore}"`);
  text = text.replace(keyValueRe("dir"), (_m, key: string) => `${key}: "${scratchResolver}"`);

  for (const key of DROPPED_KEYS) {
    text = text.replace(keyValueRe(key), "");
  }

  const conf = [
    text.trimEnd(),
    "",
    "// cortex make-live boot-test (cortex#2533): throwaway monitor for the liveness probe.",
    `http: "127.0.0.1:${opts.monitorPort.toString()}"`,
    "",
  ].join("\n");
  return { conf, args: storeDirRewritten ? [] : ["-sd", scratchStore] };
}
