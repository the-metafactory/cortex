/**
 * cortex#1265 — the arc-shell driver behind the {@link OperatorModeExportPort}:
 * the server-config bridge that exports the operator-mode JWTs from the minted
 * nsc account tree so `cortex network provision` can populate
 * `stack.nats_infra.{operator_jwt, account_jwt, system_account, system_account_jwt}`.
 *
 * Those four fields are what `cortex network join`'s O-3 renderer
 * (`renderOperatorModeBlocks`) — and the make-live bootstrap — consume to render
 * the operator-mode `.conf` with ZERO manual `nsc generate config`. Today nothing
 * populates them; this driver closes that gap.
 *
 * cortex runs nsc through arc — arc owns the nsc boundary (ADR-0013). The one
 * exception is the agents-account JetStream grant (cortex#2534, arc#384).
 * cortex shells `arc nats export-{operator,account,system} --json` and surfaces the
 * result. Same arc-shell pattern as `operator-provisioning.ts`:
 *   cortex shells to arc → arc calls nsc (`describe … --raw`) → JWT text back.
 *
 * ## Schema
 *
 * All three verbs respond with `arc.nats.operator.v1` (the same namespace as
 * init-operator / add-account / export-account). We schema-guard so a contract
 * regression fails loudly rather than silently misinterpreting the envelope.
 *
 * ## Read-only
 *
 * Every verb is a pure `nsc describe … --raw` on the arc side (no mutation), so
 * this driver is safe to call in the provision `--apply` path AFTER the account
 * mint without disturbing the live bus.
 */

import type { OperatorModeExportPort } from "./network-provision-lib";

// =============================================================================
// Arc subprocess driver (injectable for tests — mirrors operator-provisioning.ts)
// =============================================================================

export interface ArcExportRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Pluggable subprocess driver. Tests inject a fake; production uses Bun.spawn. */
export type ArcExportRunner = (argv: readonly string[]) => Promise<ArcExportRunResult>;

async function defaultArcExportRunner(argv: readonly string[]): Promise<ArcExportRunResult> {
  const proc = Bun.spawn(["arc", ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// =============================================================================
// arc.nats.operator.v1 envelope types (mirror arc src/lib/json-response.ts)
// =============================================================================

const ARC_NATS_OPERATOR_SCHEMA = "arc.nats.operator.v1";

interface ArcExportOperatorOk {
  schema: typeof ARC_NATS_OPERATOR_SCHEMA;
  ok: true;
  operator: string;
  pubKey: string;
  jwt: string;
  seedPath: string | null;
}

interface ArcExportAccountOk {
  schema: typeof ARC_NATS_OPERATOR_SCHEMA;
  ok: true;
  account: string;
  pubKey: string;
  jwt: string;
  seedPath: string | null;
}

interface ArcOperatorError {
  schema: typeof ARC_NATS_OPERATOR_SCHEMA;
  ok: false;
  error: { code: string; message: string };
}

const MIN_ARC_NOTE =
  "Ensure arc (>= the arc#1265 release shipping `nats export-operator` / " +
  "`nats export-system`) is installed and on PATH.";

/**
 * Parse the first non-blank JSON line from arc stdout, schema-guarded. Returns
 * the parsed `ok:true` envelope, OR the `{ code, reason }` from an `ok:false`
 * envelope (so the caller can branch on the error CODE — e.g. SYS not-found).
 */
function parseExportEnvelope(
  result: ArcExportRunResult,
  verb: string,
):
  | { ok: true; envelope: ArcExportOperatorOk | ArcExportAccountOk }
  | { ok: false; reason: string; code?: string } {
  const line = result.stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (line.length === 0) {
    return {
      ok: false,
      reason:
        `arc nats ${verb} returned no '${ARC_NATS_OPERATOR_SCHEMA}' envelope. ${MIN_ARC_NOTE} ` +
        `arc stderr: ${result.stderr.trim() || "(empty)"}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      ok: false,
      reason: `arc nats ${verb} returned non-JSON output: ${line.slice(0, 200)}`,
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schema?: unknown }).schema !== ARC_NATS_OPERATOR_SCHEMA
  ) {
    return {
      ok: false,
      reason:
        `arc nats ${verb} returned no valid '${ARC_NATS_OPERATOR_SCHEMA}' envelope (schema mismatch). ` +
        `arc dependency unmet (cortex#1265) — ${MIN_ARC_NOTE}`,
    };
  }
  const env = parsed as ArcExportOperatorOk | ArcExportAccountOk | ArcOperatorError;
  if (!env.ok) {
    // Read the error shape through `unknown` so the defensive guards are
    // necessary (mirrors operator-provisioning.ts's arcErrorReason).
    const raw = (env as { error?: unknown }).error;
    const code =
      raw !== null && typeof raw === "object" && typeof (raw as { code?: unknown }).code === "string"
        ? (raw as { code: string }).code
        : undefined;
    const message =
      raw !== null && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string"
        ? (raw as { message: string }).message
        : "(no message)";
    return {
      ok: false,
      reason: `arc nats ${verb} failed: ${code ?? "(unknown code)"}: ${message}`,
      ...(code !== undefined && { code }),
    };
  }
  return { ok: true, envelope: env };
}

/**
 * Build the live {@link OperatorModeExportPort} backed by `arc nats
 * export-{operator,account,system}`.
 *
 * @param runner - Injectable subprocess driver (default: `Bun.spawn(["arc", …])`).
 */
export function buildOperatorModeExportAdapter(
  runner: ArcExportRunner = defaultArcExportRunner,
): OperatorModeExportPort {
  async function run(
    argv: readonly string[],
    verb: string,
  ): Promise<
    | { ok: true; envelope: ArcExportOperatorOk | ArcExportAccountOk }
    | { ok: false; reason: string; code?: string }
  > {
    let result: ArcExportRunResult;
    try {
      result = await runner(argv);
    } catch (err) {
      return {
        ok: false,
        reason: `failed to invoke 'arc nats ${verb}' — ${err instanceof Error ? err.message : String(err)}. ${MIN_ARC_NOTE}`,
      };
    }
    return parseExportEnvelope(result, verb);
  }

  return {
    async exportOperator({ name }) {
      const res = await run(["nats", "export-operator", "--name", name, "--json"], "export-operator");
      if (!res.ok) return { ok: false, reason: res.reason };
      const env = res.envelope as ArcExportOperatorOk;
      return { ok: true, operatorJwt: env.jwt, pubKey: env.pubKey };
    },
    async exportAccount(name) {
      const res = await run(["nats", "export-account", name, "--json"], "export-account");
      if (!res.ok) return { ok: false, reason: res.reason };
      const env = res.envelope as ArcExportAccountOk;
      return { ok: true, pubKey: env.pubKey, jwt: env.jwt };
    },
    async exportSystem({ name }) {
      const res = await run(["nats", "export-system", "--name", name, "--json"], "export-system");
      if (!res.ok) {
        // SYS is optional — distinguish "no SYS account" (a clean skip) from a
        // real arc failure so provision treats absence as a soft skip.
        return { ok: false, reason: res.reason, notFound: res.code === "SYSTEM_ACCOUNT_NOT_FOUND" };
      }
      const env = res.envelope as ArcExportAccountOk;
      return { ok: true, pubKey: env.pubKey, jwt: env.jwt };
    },
  };
}
