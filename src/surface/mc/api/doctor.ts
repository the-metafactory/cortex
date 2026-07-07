/**
 * FLG-3 (docs/plan-mc-future-state.md §4.D) — `GET /api/networks/:net/doctor`.
 *
 * Surfaces the guided-join **network doctor** (epic #1479's pure
 * `runDoctorChecks`, cortex#1484/#1482) on the glass — the "why is this link
 * red" drill. The 8-leg `DoctorCheck` matrix already exists CLI-side (`cortex
 * network doctor --json`) with ZERO MC call sites; this endpoint is the first.
 * It verifies the WHOLE federation path from THIS member's own machine and
 * reports, PER LEG: a `status` (pass/fail/warn/skip), a `detail`, an owner-
 * actionable `fix`, and WHOSE job the fix is (`owner` ∈ member/hub-owner/admin/
 * peer) — plus an aggregate `verdict` (healthy/degraded/broken). The read is a
 * pure projection of what `runDoctorChecks` returns; this handler signs/mutates
 * nothing.
 *
 * Mirrors the FLG-1 handoff endpoint (`./handoff.ts`) exactly: a minimal
 * read-only {@link DoctorView} seam the server depends on, a metadata-only
 * snake_case DTO, `null` view → 503 honest, unknown network → 404, and a
 * daemon-side SHAPE-contract test (`__tests__/doctor.test.ts`).
 *
 * ## No-interiors discipline (plan invariant 1 — the DashboardSnapshot guard)
 *
 * The plan routes every new cockpit/aggregation READ through the worker-scoped
 * `DashboardSnapshot` no-interiors guard. That guard is the CF worker's SHAPE
 * contract on the public `/api/state` projection; this endpoint is a DAEMON
 * read, so the equivalent enforcement is (a) the metadata-only
 * {@link NetworkDoctorDTO} below and (b) the daemon-side SHAPE contract test
 * (`__tests__/doctor.test.ts`) — the direct analog of the worker's. The DTO
 * carries ONLY lifecycle/diagnostic metadata: per-leg id/title/status/detail/
 * fix/owner + the aggregate verdict. Critically NO secret material: the doctor
 * legs deal in PUBLIC keys (truncated to a 12-char prefix for readability) and
 * traffic COUNTS — never a seed, a payload key K, or a sealed PSK. The
 * `sealed-secret-hub-authorized` leg is a documented `skip` stub precisely
 * because the sealed ciphertext is opaque from the member side (ADR-0018 Q1);
 * it reports the gap, it never surfaces the secret (invariant 6).
 *
 * ## Verdicts verbatim (plan invariant — sourced-not-re-derived)
 *
 * Every `status`, `detail`, `fix`, `owner`, and the aggregate `verdict` is
 * passed through from `runDoctorChecks` UNCHANGED — the handler re-derives no
 * diagnosis of its own. The glass shows exactly what the CLI would.
 *
 * ## Dependency direction (surface must not import the bus)
 *
 * Like `/api/networks/:net/handoff/:member`, the server depends only on the
 * minimal {@link DoctorView} seam + the PURE result TYPES; `cortex.ts` adapts
 * the live port wiring (config + monitor adapters + the daemon runtime as the
 * probe bus) to it at boot. The surface imports pure TYPES only — never the
 * ports/adapters/bus. The one intentional divergence from the CLI's live wiring
 * (documented at the `cortex.ts` seam): the daemon reuses its ALREADY-RUNNING
 * runtime as the peer-reachable probe bus (`wrapRuntimeAsProbeBus`) rather than
 * opening a second NATS connection the way the standalone CLI must — same
 * probe transport, same config/monitor adapters, same pure `runDoctorChecks`.
 */

import type {
  DoctorRunResult,
  DoctorCheckStatus,
  DoctorCheckOwner,
  DoctorVerdict,
} from "../../../cli/cortex/commands/network-doctor-lib";

export type { DoctorCheckStatus, DoctorCheckOwner, DoctorVerdict };

/**
 * The minimal read-only seam the MC server depends on to serve the doctor
 * endpoint. `cortex.ts` supplies a live implementation (running `runDoctorChecks`
 * over the live config/monitor adapters + the daemon runtime as the probe bus);
 * tests supply a stub. `null` (no federation/registry) → the route 503s honestly.
 */
export interface DoctorView {
  /** The serving (local) principal — the member the doctor reports FROM. */
  localPrincipal: string;
  /**
   * Run the full doctor matrix for `networkId` from this member's machine.
   * Resolves to `null` when `networkId` is not a network this stack has joined
   * (→ 404). Any unexpected throw propagates to the handler's catch (→ 500);
   * the pure `runDoctorChecks` + its never-throw ports make that path
   * structural belt-and-braces, not an expected outcome.
   */
  runDoctor(networkId: string): Promise<DoctorRunResult | null>;
}

/** One doctor leg, snake_case for the wire DTO. */
export interface DoctorCheckDTO {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  detail: string;
  /**
   * Owner-actionable remediation, or `null` when the leg needs none (a `pass`
   * or an unactionable `skip`). Normalized to an explicit `null` (never absent)
   * so the no-interiors shape contract has a fixed key set at every position.
   */
  fix: string | null;
  owner: DoctorCheckOwner;
}

/**
 * `GET /api/networks/:net/doctor` response body — metadata ONLY (the
 * no-interiors DTO; see the module doc + `__tests__/doctor.test.ts`).
 */
export interface NetworkDoctorDTO {
  network_id: string;
  /** Aggregate verdict, verbatim from `runDoctorChecks`. */
  verdict: DoctorVerdict;
  /** Every leg, in `runDoctorChecks` order (config → pairs → monitor/leaf → peers). */
  checks: DoctorCheckDTO[];
}

export interface HandleGetDoctorOpts {
  networkId: string;
}

/**
 * Handle `GET /api/networks/:net/doctor`.
 *
 * `view === null` → 503 (no federation configured — honest). Unknown network →
 * 404. Otherwise run the doctor (never-throw ports + pure orchestration) and
 * project the result into the metadata-only DTO. The catch is a structural
 * belt-and-braces (same posture as `handleGetHandoff`).
 */
export async function handleGetDoctor(
  view: DoctorView | null,
  opts: HandleGetDoctorOpts,
): Promise<Response> {
  try {
    if (view === null) {
      return Response.json(
        {
          error:
            "network doctor unavailable — no federation/registry configured on this stack",
        },
        { status: 503 },
      );
    }

    const result = await view.runDoctor(opts.networkId);
    if (result === null) {
      return Response.json(
        { error: `network "${opts.networkId}" is not one this stack has joined` },
        { status: 404 },
      );
    }

    // Verbatim projection — status/detail/fix/owner + the aggregate verdict are
    // passed through unchanged (invariant: verdicts sourced, never re-derived).
    // `fix` is normalized to an explicit `null` so the shape contract sees a
    // fixed key set on every leg.
    const dto: NetworkDoctorDTO = {
      network_id: opts.networkId,
      verdict: result.verdict,
      checks: result.checks.map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        detail: c.detail,
        fix: c.fix ?? null,
        owner: c.owner,
      })),
    };

    return Response.json(dto);
  } catch (err) {
    process.stderr.write(
      `[api] GET /api/networks/:net/doctor failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return Response.json(
      {
        error: `Failed to run network doctor: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}
