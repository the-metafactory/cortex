/**
 * `cortex network doctor` — LIVE adapters (cortex#1484, epic #1479).
 *
 * Wires the real stack config file, the local nats-server HTTP monitor, and
 * (via `createLiveProbeBus` in `network-ping-adapters.ts`) the real
 * `MyelinRuntime` into the {@link NetworkDoctorPorts} the pure orchestrator
 * (`network-doctor-lib.ts`) depends on. Constructed only on a real `cortex
 * network doctor` invocation; tests inject fakes and never reach this file.
 *
 * READ-ONLY: `buildDoctorConfigPort` only reads `policy.federated.networks[]`
 * (`readNetworksFromConfig`, the same reader join/leave/rotate-key use) and,
 * best-effort, the rendered per-network leaf-include file; `buildMonitorPort`
 * only GETs `/leafz`. Neither ever writes. `doctor` never mutates config,
 * files, or services — its one live effect is the bounded probe echo the
 * caller wires separately via `createLiveProbeBus`/`wrapRuntimeAsProbeBus`
 * (the SAME probe transport `network-ping-adapters.ts` uses, not re-implemented).
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

import { expandTilde } from "../../../common/config/loader";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import { leafIncludeFileName } from "../../../common/nats/leaf-remote-renderer";
import {
  resolveMonitorBase,
  DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
  type LivePortsConfig,
} from "./network-adapters";
import type {
  DoctorConfigPort,
  DoctorNetworksSnapshot,
  LeafzResponse,
  MonitorPort,
} from "./network-doctor-ports";

/** Bound the `/leafz` probe so a hung monitor cannot stall `doctor` forever. */
export const DEFAULT_LEAFZ_TIMEOUT_MS = DEFAULT_HEALTH_PROBE_TIMEOUT_MS;

// =============================================================================
// cortex#1482 (epic #1479, join-3, Pair 2) — resolver_preload account lookup.
// =============================================================================

/**
 * True iff `accountPubkey` appears as a top-level KEY inside the
 * `resolver_preload { … }` block of `text` (not merely anywhere in the file —
 * a leaf remote's OWN `account: "<pubkey>"` line commonly carries the SAME
 * account pubkey, so a bare substring search over the whole file would
 * false-positive even when the account is NOT actually preloaded).
 * `undefined` when `text` has no `resolver_preload { … }` block at all (can't
 * determine — e.g. a non-operator-mode / hard-isolated bus, where the
 * question doesn't apply, or an unbalanced/malformed config).
 *
 * The brace-matched scan mirrors `insertIntoResolverPreload` (this same
 * codebase's existing resolver_preload-block locator, in
 * `common/nats/leaf-remote-renderer.ts` as of cortex#1480 — previously
 * `network-make-live-adapters.ts`) — same block-opening regex, same
 * depth-counted brace walk — but EXTRACTS the block instead of inserting
 * into it.
 *
 * Cheap-guard limitation (Sage review, nit 5): before the walk we blank out
 * FULL-LINE `//` comments (see {@link blankFullLineComments}) so a stray
 * `{`/`}` in a comment line can't unbalance the scan. We deliberately do NOT
 * attempt to skip braces inside QUOTED strings — resolver_preload entries are
 * `<pubkey>: <JWT>` pairs whose values (base32 nkeys, `eyJ…` JWTs) never
 * contain braces, so a brace inside a quoted value doesn't occur in practice;
 * a full string-tokenizer would balloon scope for a case NATS configs don't
 * produce.
 */
export function resolverPreloadHasAccountKey(text: string, accountPubkey: string): boolean | undefined {
  // Index-preserving: comment chars become spaces (same length), so every
  // offset below still lines up with the original `text`.
  const scanned = blankFullLineComments(text);
  const key = /resolver_preload\s*[:=]?\s*\{/.exec(scanned);
  if (key === null) return undefined;
  const open = key.index + key[0].length - 1; // index of the `{`
  let depth = 0;
  let close = -1;
  for (let i = open; i < scanned.length; i++) {
    const ch = scanned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return undefined; // unbalanced braces — can't determine
  const block = scanned.slice(open + 1, close);
  const escaped = accountPubkey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s{,])${escaped}\\s*:`).test(block);
}

/**
 * Replace the `//…`-to-end-of-line portion of any FULL-LINE comment (a line
 * whose first non-whitespace is `//`) with spaces of the SAME length, so
 * character offsets are preserved for the brace walk. Only full-line comments
 * are blanked — an inline `//` (which in a real config only ever follows a
 * value, e.g. `tls://host` is NOT line-leading) is left alone, so we never
 * mangle a `tls://` scheme or a value's own `//`.
 */
function blankFullLineComments(text: string): string {
  return text.replace(
    /^([ \t]*)\/\/[^\n]*/gm,
    (match, indent: string) => indent + " ".repeat(match.length - indent.length),
  );
}

/** Inputs {@link buildDoctorConfigPort} needs — a subset of {@link LivePortsConfig}. */
export interface DoctorConfigAdapterConfig {
  /** The COMPOSED `policy.federated.networks[]` from the loaded config — read
   *  off the `LoadedConfig` the caller already built (the same source
   *  `derivePingInputs` uses), NOT re-parsed off the raw `--config` file. This
   *  is load-bearing for the config-split layout (#814): `policy.federated`
   *  lives in `stacks/<slug>.yaml`, so re-reading the pointer file directly
   *  would find zero networks. */
  networks: PolicyFederatedNetwork[];
  /** The stack's nats config path — used to locate the per-network leaf-include
   *  file (`leafnodes-<network>.conf`) beside it for the account derivation. */
  natsConfigPath?: string;
}

/**
 * The live {@link DoctorConfigPort}: `readNetworks()` returns the COMPOSED
 * `policy.federated.networks[]` (handling both the config-split and monolithic
 * layouts the daemon loads); `expectedFedAccount()` best-effort parses the
 * rendered per-network leaf-include file's `account:` line, when one exists on
 * disk. Never throws.
 */
export function buildDoctorConfigPort(cfg: DoctorConfigAdapterConfig): DoctorConfigPort {
  return {
    readNetworks(): DoctorNetworksSnapshot {
      return { networks: cfg.networks };
    },

    expectedFedAccount(networkId: string): string | undefined {
      const natsConfigPath = expandTilde(cfg.natsConfigPath ?? "");
      if (natsConfigPath.length === 0) return undefined;

      let fileName: string;
      try {
        fileName = leafIncludeFileName(networkId);
      } catch (_err) {
        // Invalid network-id shape — nothing to derive; the check degrades to
        // warn/report-only (undefined ⇒ "not derivable"). Safe to ignore.
        return undefined;
      }

      const includePath = join(dirname(natsConfigPath), fileName);
      if (!existsSync(includePath)) return undefined;

      let text: string;
      try {
        text = readFileSync(includePath, "utf-8");
      } catch (err) {
        process.stderr.write(
          `network-doctor-adapters: could not read leaf include ${includePath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return undefined;
      }
      // The include file is rendered by `serializeRemote` (leaf-remote-renderer.ts)
      // — a bare `account: <nkey-U>` line, unquoted, when the leaf is
      // operator-mode-bound. Absent entirely for a `$G`/default-bus remote.
      const m = /^\s*account:\s*(\S+)/m.exec(text);
      return m?.[1];
    },

    // cortex#1482 (Pair 2) — reads the SAME base nats config `natsConfigPath`
    // points at (not the per-network leaf-include file `expectedFedAccount`
    // reads) since `resolver_preload` lives on the bus's OWN config, not the
    // per-network include.
    resolverPreloadHasAccount(accountPubkey: string): boolean | undefined {
      const natsConfigPath = expandTilde(cfg.natsConfigPath ?? "");
      if (natsConfigPath.length === 0 || !existsSync(natsConfigPath)) return undefined;

      let text: string;
      try {
        text = readFileSync(natsConfigPath, "utf-8");
      } catch (err) {
        process.stderr.write(
          `network-doctor-adapters: could not read nats config ${natsConfigPath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return undefined;
      }
      return resolverPreloadHasAccountKey(text, accountPubkey);
    },
  };
}

/**
 * The live {@link MonitorPort}: resolves the monitor base via the SAME
 * `resolveMonitorBase` precedence `status`/join's health-probe use, and
 * fetches `/leafz` with a bounded timeout.
 */
export function buildMonitorPort(cfg: LivePortsConfig): MonitorPort {
  return {
    resolve() {
      return resolveMonitorBase(cfg);
    },

    async fetchLeafz(): Promise<LeafzResponse | undefined> {
      const base = resolveMonitorBase(cfg).url.replace(/\/+$/, "");
      const timeoutMs = cfg.healthProbeTimeoutMs ?? DEFAULT_LEAFZ_TIMEOUT_MS;
      try {
        const res = await fetch(`${base}/leafz`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return undefined;
        return (await res.json()) as LeafzResponse;
      } catch (err) {
        process.stderr.write(
          `network-doctor-adapters: /leafz fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return undefined;
      }
    },
  };
}
