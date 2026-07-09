/**
 * G1c (#1117, ADR-0013) — live adapter for {@link FederationWiringPort}.
 *
 * Shells out to `arc nats add-federation-export` (built in G1b / arc#243) to
 * wire the LOCAL-SIDE `federated.>` export/import between the stack's
 * federation account (leaf-bound) and agents account. Follows the arc-shell
 * pattern established in `creds.ts` (`callArcNats` / `ArcRunner`):
 *   cortex shells to arc → arc calls nsc → nsc mutates the local NSC store.
 *
 * cortex NEVER calls nsc directly (ADR-0013 sovereign model invariant).
 * cortex NEVER references a peer account (local-only wiring).
 * cortex NEVER puts the network id on any NATS wire.
 *
 * ## Same-account / G1d gap
 *
 * ADR-0013 §3 says ONE dedicated federation account per stack (distinct from
 * agents). Today the cortex config has a single `stack.nats_infra.account`
 * (the leaf-bound account). When `agentsAccount` is absent (the current
 * state), the call is sent with `--from-account == --to-account` (same
 * account). The arc primitive handles the same-account case as a no-op (both
 * accounts are the same NSC account; no cross-account routing needed). A
 * dedicated `agents_account` config field that splits the two is tracked as
 * G1d (cortex#1117 follow-up).
 *
 * ## Schema
 *
 * arc responds with `arc.nats.federation.v1` (a SEPARATE schema namespace for
 * federation commands — arc#243 / `ARC_NATS_FEDERATION_SCHEMA` in arc's
 * `src/lib/json-response.ts` — distinct from `arc.nats.v1` used by
 * add-bot/reissue-bot and `arc.nats.operator.v1` used by init-operator/
 * add-account). We guard on the schema string so a future arc that returns a
 * different schema for this subcommand (a contract regression) fails loudly
 * rather than silently misinterpreting the envelope.
 *
 * NOTE (cortex#1225): this adapter originally required `arc.nats.v2` — a schema
 * arc never shipped and explicitly chose NOT to (it namespaced federation under
 * `arc.nats.federation.v1` so consumers guarding on `arc.nats.v1` stay
 * unaffected). The mismatch made `cortex network provision --apply` ALWAYS fail
 * at the federation-wiring step against real arc; the unit tests passed because
 * their fixtures mocked the never-shipped `arc.nats.v2`. Fixed to accept the
 * schema arc actually emits.
 */

import type { FederationWiringPort } from "./network-ports";

// =============================================================================
// Arc subprocess driver (injectable for tests — same pattern as creds.ts)
// =============================================================================

/** Result of one arc subprocess invocation. */
export interface ArcFederationRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Pluggable subprocess driver. Tests inject a fake; production uses Bun.spawn. */
export type ArcFederationRunner = (argv: readonly string[]) => Promise<ArcFederationRunResult>;

async function defaultArcFederationRunner(argv: readonly string[]): Promise<ArcFederationRunResult> {
  const proc = Bun.spawn(["arc", ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// =============================================================================
// arc.nats.federation.v1 envelope types
//
// Mirrors arc's `AddFederationExportJson` (src/lib/json-response.ts). arc may
// additionally emit a `pushResult` field on success; we intentionally do not
// model it (cortex does not consume it — extra fields are forward-compatible).
// =============================================================================

/** Schema arc emits for `nats add-federation-export` (arc#243). Must match
 *  arc's `ARC_NATS_FEDERATION_SCHEMA`; a divergence here breaks provision. */
const ARC_NATS_FEDERATION_SCHEMA = "arc.nats.federation.v1";

interface ArcFederationOk {
  schema: typeof ARC_NATS_FEDERATION_SCHEMA;
  ok: true;
  fromAccount: string;
  toAccount: string;
  subject: string;
  exportAdded: boolean;
  importAdded: boolean;
  exportAlreadyPresent: boolean;
  importAlreadyPresent: boolean;
}

interface ArcFederationError {
  schema: typeof ARC_NATS_FEDERATION_SCHEMA;
  ok: false;
  error: { code: string; message: string };
}

type ArcFederationEnvelope = ArcFederationOk | ArcFederationError;

// =============================================================================
// buildFederationWiringAdapter
// =============================================================================

/**
 * Build the live {@link FederationWiringPort} backed by `arc nats add-federation-export`.
 *
 * @param runner - Injectable subprocess driver (default: `Bun.spawn(["arc", …])`).
 *
 * ## Never throws
 *
 * All errors (spawn failure, non-JSON output, arc `ok: false`) are surfaced as
 * `{ ok: false, reason }` — consistent with the `joinNetwork` "never throws"
 * contract. The `try/catch` around the spawn mirrors the pattern in `creds.ts`.
 */
export function buildFederationWiringAdapter(
  runner: ArcFederationRunner = defaultArcFederationRunner,
): FederationWiringPort {
  return {
    async wireLocalFederation({ federationAccount, agentsAccount, apply }) {
      // Same-account / G1d: when agentsAccount is absent, use federationAccount
      // as the --to-account (same NSC account = no cross-account routing needed;
      // the arc primitive handles this as a no-op). A dedicated agents_account
      // config field that splits the two is tracked as G1d (#1117 follow-up).
      const toAccount = agentsAccount ?? federationAccount;
      if (agentsAccount === undefined) {
        // Nit 2 (G1c review) — make the G1d gap operationally visible. When no
        // dedicated agents account is configured, from==to is a same-account no-op
        // in the arc primitive. Log at WARN so the principal can see the gap and
        // knows to configure agents_account (G1d) when they split accounts.
        process.stderr.write(
          `[cortex network join] WARN: federation wiring is a same-account no-op ` +
          `(dedicated federation account not configured — G1d, cortex#1117 follow-up). ` +
          `Set agents_account in the stack config to wire cross-account export/import.\n`,
        );
      }

      const argv: string[] = [
        "nats",
        "add-federation-export",
        "--from-account", federationAccount,
        "--to-account", toAccount,
        "--subject", "federated.>",
        // arc's add-federation-export has NO --dry-run flag; dry-run is the
        // DEFAULT and only --apply mutates (`arc nats add-federation-export
        // --help`: "--apply … (default: dry-run)"). Passing --dry-run makes arc
        // exit 1 with `unknown option '--dry-run'` and empty stdout, so the
        // dry-run join path (network-lib.ts: apply defaults false) always failed
        // federation-wiring. Emit --apply only when mutating; nothing otherwise.
        ...(apply ? ["--apply"] : []),
        "--json",
      ];

      let result: ArcFederationRunResult;
      try {
        result = await runner(argv);
      } catch (err) {
        return {
          ok: false,
          reason:
            `failed to invoke 'arc nats add-federation-export' — ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Ensure arc is installed and on PATH (see docs/design-g1-account-topology.md).`,
        };
      }

      // Parse the first non-blank JSON line (same pattern as creds.ts).
      const line = result.stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
      if (line.length === 0) {
        return {
          ok: false,
          reason:
            `arc returned no valid '${ARC_NATS_FEDERATION_SCHEMA}' envelope. ` +
            `Confirm arc is installed and that 'arc nats add-federation-export' supports --json. ` +
            `arc stderr: ${result.stderr.trim() || "(empty)"}`,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return {
          ok: false,
          reason:
            `arc returned no valid '${ARC_NATS_FEDERATION_SCHEMA}' envelope (JSON parse failed). ` +
            `arc output: ${line.slice(0, 200)}`,
        };
      }

      // Schema guard — fail loudly if arc returns an unexpected schema string.
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { schema?: unknown }).schema !== ARC_NATS_FEDERATION_SCHEMA
      ) {
        return {
          ok: false,
          reason:
            `arc returned no valid '${ARC_NATS_FEDERATION_SCHEMA}' envelope (schema mismatch). ` +
            `Got: ${JSON.stringify((parsed as { schema?: unknown }).schema ?? "(none)")}. ` +
            `Ensure arc supports the G1b add-federation-export command (arc#243).`,
        };
      }

      const envelope = parsed as ArcFederationEnvelope;

      if (!envelope.ok) {
        // Shape-check before reading .error so a malformed envelope (ok:false but
        // missing/mistyped .error) surfaces a clear diagnostic rather than a
        // runtime TypeError on .error.code / .error.message.
        const rawError = (envelope as { error?: unknown }).error;
        const errCode =
          rawError !== null &&
          typeof rawError === "object" &&
          "code" in rawError &&
          typeof (rawError as { code?: unknown }).code === "string"
            ? (rawError as { code: string }).code
            : "(unknown code)";
        const errMsg =
          rawError !== null &&
          typeof rawError === "object" &&
          "message" in rawError &&
          typeof (rawError as { message?: unknown }).message === "string"
            ? (rawError as { message: string }).message
            : "(no message)";
        return {
          ok: false,
          reason: `arc nats add-federation-export failed: ${errCode}: ${errMsg}`,
        };
      }

      const ok = envelope;
      const parts: string[] = [];
      if (ok.exportAlreadyPresent) parts.push("export already present");
      else if (ok.exportAdded) parts.push("export added");
      if (ok.importAlreadyPresent) parts.push("import already present");
      else if (ok.importAdded) parts.push("import added");
      const note = parts.length > 0
        ? parts.join(", ")
        : "export+import wired (idempotent)";

      return { ok: true, note };
    },
  };
}
