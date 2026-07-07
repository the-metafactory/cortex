/**
 * FLG-3 (docs/plan-mc-future-state.md §4.D) — `handleGetDoctor` tests.
 *
 * Two things this file locks down:
 *   1. Availability + verbatim projection: 503 (no federation), 404 (not
 *      joined), and — on a real run — that every leg's status/detail/fix/owner
 *      and the aggregate verdict pass through the endpoint UNCHANGED (invariant:
 *      verdicts sourced, never re-derived), INCLUDING the two legs the plan
 *      names explicitly (`sealed-secret-hub-authorized`, `peer-reachable:<p>`).
 *   2. The no-interiors SHAPE guard (invariant 1 — the daemon analog of
 *      `worker/src/__tests__/dashboard-snapshot-contract.test.ts`): the
 *      `NetworkDoctorDTO` and its legs carry ONLY the allow-listed metadata keys
 *      at every position. This is how the read "flows through the DashboardSnapshot
 *      guard" on the daemon side — a metadata-only contract, asserted here. A new
 *      field that could leak an interior / secret fails HERE, consciously.
 */

import { describe, it, expect } from "bun:test";
import {
  handleGetDoctor,
  type DoctorView,
  type NetworkDoctorDTO,
} from "../doctor";
import type {
  DoctorRunResult,
  DoctorCheck,
} from "../../../../cli/cortex/commands/network-doctor-lib";
import { DOCTOR_EXIT_CODE } from "../../../../cli/cortex/commands/network-doctor-lib";

/** A representative 8-leg result — includes the two plan-named legs + every status. */
function sampleResult(): DoctorRunResult {
  const checks: DoctorCheck[] = [
    { id: "config-network", title: 'network "research" configured', status: "pass", detail: "2 peer(s), 3 accept_subjects", owner: "member" },
    { id: "registered-vs-fed-account", title: "registered pubkey vs FED account (Pair 1)", status: "pass", detail: "different keys, as expected (ADR-0018)", owner: "member" },
    { id: "resolver-preload-account", title: "leaf account preloaded on this bus (Pair 2)", status: "pass", detail: "account U123456789012… is preloaded on this bus", owner: "member" },
    {
      id: "sealed-secret-hub-authorized",
      title: "registry sealed-secret ⟷ hub authorization (Pair 3)",
      status: "skip",
      detail: "not implemented from the member side — the registry holds only an opaque ciphertext (ADR-0018 Q1)",
      owner: "hub-owner",
    },
    { id: "monitor-reachable", title: "local NATS monitor reachable", status: "warn", detail: "no monitor configured for this bus", fix: "enable http_port/monitor_port on the local bus", owner: "member" },
    { id: "leaf-established", title: "leaf established", status: "skip", detail: "skipped — no /leafz data (see monitor-reachable)", owner: "member" },
    { id: "leaf-account-bound", title: "leaf account binding", status: "skip", detail: "skipped — no established leaf (see leaf-established)", owner: "member" },
    {
      id: "peer-reachable:jc/default",
      title: "peer reachable: jc/default",
      status: "fail",
      detail: "no echo from jc/default within the probe timeout",
      fix: "peer/hub — peer offline, its leaf is down, or the hub is partitioned; check the peer's own `cortex network doctor`",
      owner: "peer",
    },
  ];
  return { checks, verdict: "degraded", exitCode: DOCTOR_EXIT_CODE.degraded };
}

/** A stub view resolving a fixed result for one network id (else `null`). */
function stubView(networkId: string, result: DoctorRunResult): DoctorView {
  return {
    localPrincipal: "andreas",
    runDoctor: (net): Promise<DoctorRunResult | null> =>
      Promise.resolve(net === networkId ? result : null),
  };
}

async function body(res: Response): Promise<NetworkDoctorDTO> {
  return (await res.json()) as NetworkDoctorDTO;
}

describe("handleGetDoctor — availability", () => {
  it("503s when no doctor view is wired (no federation)", async () => {
    const res = await handleGetDoctor(null, { networkId: "research" });
    expect(res.status).toBe(503);
  });

  it("404s for a network this stack has not joined", async () => {
    const res = await handleGetDoctor(stubView("research", sampleResult()), {
      networkId: "not-joined",
    });
    expect(res.status).toBe(404);
  });

  it("500s (honest, not a crash) when the run throws unexpectedly", async () => {
    const view: DoctorView = {
      localPrincipal: "andreas",
      runDoctor: () => Promise.reject(new Error("boom")),
    };
    const res = await handleGetDoctor(view, { networkId: "research" });
    expect(res.status).toBe(500);
  });
});

describe("handleGetDoctor — verbatim projection", () => {
  it("projects verdict + every leg's status/detail/fix/owner unchanged", async () => {
    const result = sampleResult();
    const dto = await body(
      await handleGetDoctor(stubView("research", result), { networkId: "research" }),
    );
    expect(dto.network_id).toBe("research");
    expect(dto.verdict).toBe("degraded");
    expect(dto.checks.length).toBe(result.checks.length);
    for (let i = 0; i < result.checks.length; i++) {
      const src = result.checks[i]!;
      const out = dto.checks[i]!;
      expect(out.id).toBe(src.id);
      expect(out.title).toBe(src.title);
      expect(out.status).toBe(src.status);
      expect(out.detail).toBe(src.detail);
      expect(out.owner).toBe(src.owner);
      // fix passes through, normalized to null when absent.
      expect(out.fix).toBe(src.fix ?? null);
    }
  });

  it("surfaces the two plan-named legs (sealed-secret-hub-authorized + peer-reachable:<p>)", async () => {
    const dto = await body(
      await handleGetDoctor(stubView("research", sampleResult()), { networkId: "research" }),
    );
    const sealed = dto.checks.find((c) => c.id === "sealed-secret-hub-authorized")!;
    expect(sealed.status).toBe("skip");
    expect(sealed.owner).toBe("hub-owner");

    const peer = dto.checks.find((c) => c.id.startsWith("peer-reachable:"))!;
    expect(peer.id).toBe("peer-reachable:jc/default");
    expect(peer.status).toBe("fail");
    expect(peer.owner).toBe("peer");
    expect(peer.fix).not.toBeNull();
  });

  it("normalizes a pass leg's absent fix to explicit null", async () => {
    const dto = await body(
      await handleGetDoctor(stubView("research", sampleResult()), { networkId: "research" }),
    );
    const pass = dto.checks.find((c) => c.id === "config-network")!;
    expect(pass.status).toBe("pass");
    expect(pass.fix).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No-interiors SHAPE guard — the daemon analog of the worker's
// dashboard-snapshot-contract.test.ts. Asserts the DTO carries ONLY the
// allow-listed metadata keys at every position. A new field that could leak an
// interior / secret fails HERE, consciously (grow the allow-list = a real edit).
// ---------------------------------------------------------------------------

const DTO_KEYS = new Set(["network_id", "verdict", "checks"]);
const CHECK_KEYS = new Set(["id", "title", "status", "detail", "fix", "owner"]);

function assertKeys(obj: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unexpected = Object.keys(obj).filter((k) => !allowed.has(k));
  expect([label, unexpected]).toEqual([label, []]);
}

describe("handleGetDoctor — no-interiors SHAPE guard (invariant 1)", () => {
  it("the DTO + its legs carry only the allow-listed metadata keys", async () => {
    const dto = await body(
      await handleGetDoctor(stubView("research", sampleResult()), { networkId: "research" }),
    );
    assertKeys(dto as unknown as Record<string, unknown>, DTO_KEYS, "NetworkDoctorDTO");
    expect(dto.checks.length).toBeGreaterThan(0);
    for (const leg of dto.checks) {
      assertKeys(leg as unknown as Record<string, unknown>, CHECK_KEYS, `checks[${leg.id}]`);
    }
  });
});
