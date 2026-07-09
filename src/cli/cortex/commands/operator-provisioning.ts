/**
 * G1d (cortex#1139, ADR-0013 sovereign model) — the arc-shell driver for the
 * sovereign account-topology primitives `arc nats init-operator` and
 * `arc nats add-account` (arc#252 / arc#253).
 *
 * `cortex network provision <stack>` composes these alongside the existing
 * `arc nats add-federation-export` (network-federation-wiring.ts) to stand up a
 * principal's OWN NSC account tree — their nsc operator + a dedicated
 * federation account + a per-stack agents account — so the stack can federate
 * (ADR-0013: every principal runs their own nsc operator, hub mints nothing).
 *
 * cortex NEVER calls nsc directly — arc owns the nsc boundary; cortex shells to
 * `arc nats …` and surfaces the result. Same arc-shell pattern as `creds.ts`
 * (`callArcNats` / `ArcRunner`) and `network-federation-wiring.ts`:
 *   cortex shells to arc → arc calls nsc → nsc mutates the local nsc store.
 *
 * ## Schema
 *
 * Both verbs respond with `arc.nats.operator.v1` (a namespace distinct from
 * `arc.nats.v1` = add-bot and `arc.nats.federation.v1` = add-federation-export,
 * so existing consumers are unaffected). We guard on the schema string so a
 * contract regression fails loudly rather than silently misinterpreting the
 * envelope.
 *
 * ## Mutation seam
 *
 * `init-operator` and `add-account` have NO dry-run mode in arc (they mint
 * idempotently when absent, no-op when present). So this driver is only invoked
 * on the `--apply` path; the provision orchestrator computes its dry-run PLAN
 * from config + filesystem state and never shells here when not applying.
 */

// =============================================================================
// Arc subprocess driver (injectable for tests — same pattern as creds.ts)
// =============================================================================

/** Result of one arc subprocess invocation. */
export interface ArcOperatorRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Pluggable subprocess driver. Tests inject a fake; production uses Bun.spawn. */
export type ArcOperatorRunner = (argv: readonly string[]) => Promise<ArcOperatorRunResult>;

async function defaultArcOperatorRunner(argv: readonly string[]): Promise<ArcOperatorRunResult> {
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

interface ArcInitOperatorOk {
  schema: typeof ARC_NATS_OPERATOR_SCHEMA;
  ok: true;
  operator: string;
  pubKey: string;
  created: boolean;
  alreadyExisted: boolean;
  seedPath: string | null;
}

interface ArcAddAccountOk {
  schema: typeof ARC_NATS_OPERATOR_SCHEMA;
  ok: true;
  account: string;
  pubKey: string;
  created: boolean;
  alreadyExisted: boolean;
}

interface ArcOperatorError {
  schema: typeof ARC_NATS_OPERATOR_SCHEMA;
  ok: false;
  error: { code: string; message: string };
}

// =============================================================================
// Port surface the provision orchestrator depends on
// =============================================================================

/** init-operator result, surfaced log-safe (no seed material). */
export type InitOperatorResult =
  | { ok: true; operator: string; pubKey: string; created: boolean; alreadyExisted: boolean; seedPath: string | null }
  | { ok: false; reason: string };

/** add-account result. `pubKey` is the account-class (`A…`) NKey. */
export type AddAccountResult =
  | { ok: true; account: string; pubKey: string; created: boolean; alreadyExisted: boolean }
  | { ok: false; reason: string };

/**
 * The seam the provision orchestrator mints the NSC account tree through. Two
 * methods, one per arc verb. Live impl shells to arc; tests inject a fake that
 * records the calls in order. NEVER throws (arc failures → `{ ok: false }`).
 */
export interface OperatorProvisioningPort {
  /** `arc nats init-operator --name <name> [--force] --json` — mint the
   *  principal's nsc operator if absent (idempotent; `force` recreates). */
  initOperator(opts: { name: string; force: boolean }): Promise<InitOperatorResult>;
  /** `arc nats add-account <name> --json` — mint an account under the current
   *  operator if absent (idempotent). Called once per account (federation +
   *  per-stack agents). */
  addAccount(opts: { name: string }): Promise<AddAccountResult>;
}

// =============================================================================
// buildOperatorProvisioningAdapter
// =============================================================================

const MIN_ARC_NOTE =
  "Ensure arc (>= the arc#253 release shipping `nats init-operator` / " +
  "`nats add-account`) is installed and on PATH.";

/** Parse the first non-blank JSON line from arc stdout, schema-guarded. */
function parseOperatorEnvelope(
  result: ArcOperatorRunResult,
):
  | { ok: true; envelope: ArcInitOperatorOk | ArcAddAccountOk | ArcOperatorError }
  | { ok: false; reason: string } {
  const line = result.stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (line.length === 0) {
    return {
      ok: false,
      reason:
        `arc returned no valid '${ARC_NATS_OPERATOR_SCHEMA}' envelope. ${MIN_ARC_NOTE} ` +
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
        `arc returned no valid '${ARC_NATS_OPERATOR_SCHEMA}' envelope (JSON parse failed). ` +
        `arc output: ${line.slice(0, 200)}`,
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
        `arc returned no valid '${ARC_NATS_OPERATOR_SCHEMA}' envelope (schema mismatch). ` +
        `Got: ${JSON.stringify((parsed as { schema?: unknown }).schema ?? "(none)")}. ` +
        `arc dependency unmet (cortex#1139 / G1d) — ${MIN_ARC_NOTE}`,
    };
  }
  return { ok: true, envelope: parsed as ArcInitOperatorOk | ArcAddAccountOk | ArcOperatorError };
}

/** Extract `{ code, message }` from an `ok:false` envelope, shape-checked. */
function arcErrorReason(envelope: ArcOperatorError, verb: string): string {
  const raw = (envelope as { error?: unknown }).error;
  const code =
    raw !== null && typeof raw === "object" && typeof (raw as { code?: unknown }).code === "string"
      ? (raw as { code: string }).code
      : "(unknown code)";
  const message =
    raw !== null && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string"
      ? (raw as { message: string }).message
      : "(no message)";
  return `arc nats ${verb} failed: ${code}: ${message}`;
}

/**
 * Build the live {@link OperatorProvisioningPort} backed by `arc nats
 * init-operator` + `arc nats add-account`.
 *
 * @param runner - Injectable subprocess driver (default: `Bun.spawn(["arc", …])`).
 */
export function buildOperatorProvisioningAdapter(
  runner: ArcOperatorRunner = defaultArcOperatorRunner,
): OperatorProvisioningPort {
  async function run(argv: readonly string[], verb: string): Promise<
    { ok: true; envelope: ArcInitOperatorOk | ArcAddAccountOk } | { ok: false; reason: string }
  > {
    let result: ArcOperatorRunResult;
    try {
      result = await runner(argv);
    } catch (err) {
      return {
        ok: false,
        reason:
          `failed to invoke 'arc nats ${verb}' — ${err instanceof Error ? err.message : String(err)}. ${MIN_ARC_NOTE}`,
      };
    }
    const parsed = parseOperatorEnvelope(result);
    if (!parsed.ok) return parsed;
    if (!parsed.envelope.ok) return { ok: false, reason: arcErrorReason(parsed.envelope, verb) };
    return { ok: true, envelope: parsed.envelope };
  }

  return {
    async initOperator({ name, force }) {
      const argv = ["nats", "init-operator", "--name", name, ...(force ? ["--force"] : []), "--json"];
      const res = await run(argv, "init-operator");
      if (!res.ok) return res;
      const env = res.envelope as ArcInitOperatorOk;
      return {
        ok: true,
        operator: env.operator,
        pubKey: env.pubKey,
        created: env.created,
        alreadyExisted: env.alreadyExisted,
        seedPath: env.seedPath,
      };
    },
    async addAccount({ name }) {
      const res = await run(["nats", "add-account", name, "--json"], "add-account");
      if (!res.ok) return res;
      const env = res.envelope as ArcAddAccountOk;
      return {
        ok: true,
        account: env.account,
        pubKey: env.pubKey,
        created: env.created,
        alreadyExisted: env.alreadyExisted,
      };
    },
  };
}
