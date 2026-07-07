/**
 * FLG-4 — tests for the per-member lifecycle STATE projection added to
 * `resolveAdmittedRoster`. The `admitted`/`pending` arrays are UNCHANGED
 * (back-compat); `states` is the additive superset covering EVERY row incl.
 * former members (revoked/departed/rejected), with honest defaults for the
 * optional facets.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveAdmittedRoster,
  type AdmissionRow,
  type AdmissionRowsProvider,
  type AdmissionRowsResult,
} from "../admission-read";

function provider(rows: AdmissionRow[], scope: "complete" | "self" = "complete"): AdmissionRowsProvider {
  return {
    readAdmissionRows: (): Promise<AdmissionRowsResult> =>
      Promise.resolve({ ok: true, rows, scope }),
  };
}

const NET = "metafactory";

describe("resolveAdmittedRoster — FLG-4 states projection", () => {
  it("projects every row (incl. former members) into states, keeping admitted/pending unchanged", async () => {
    const rows: AdmissionRow[] = [
      { principal_id: "andreas", network_id: NET, status: "ADMITTED", sealed: true, hub_authorized_at: "2026-07-08T00:00:00.000Z" },
      { principal_id: "newcomer", network_id: NET, status: "PENDING" },
      { principal_id: "leaver", network_id: NET, status: "DEPARTED" },
      { principal_id: "kicked", network_id: NET, status: "REVOKED" },
      { principal_id: "declined", network_id: NET, status: "REJECTED" },
    ];
    const res = await resolveAdmittedRoster(NET, provider(rows));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Back-compat: admitted/pending arrays unchanged.
    expect(res.roster.admitted).toEqual(["andreas"]);
    expect(res.roster.pending).toEqual(["newcomer"]);

    // States: EVERY row, with honest defaults.
    const states = res.roster.states ?? [];
    expect(states.map((s) => s.principal_id)).toEqual([
      "andreas",
      "newcomer",
      "leaver",
      "kicked",
      "declined",
    ]);
    const andreas = states.find((s) => s.principal_id === "andreas");
    expect(andreas).toEqual({
      principal_id: "andreas",
      status: "ADMITTED",
      sealed: true,
      hub_authorized_at: "2026-07-08T00:00:00.000Z",
      authorship: "unchecked",
    });
    // DEPARTED and REVOKED are DISTINCT statuses in the projection.
    expect(states.find((s) => s.principal_id === "leaver")?.status).toBe("DEPARTED");
    expect(states.find((s) => s.principal_id === "kicked")?.status).toBe("REVOKED");
  });

  it("defaults optional facets to honest absence (sealed:false, hub_authorized_at:null, authorship:unchecked)", async () => {
    const rows: AdmissionRow[] = [
      { principal_id: "andreas", network_id: NET, status: "ADMITTED" },
    ];
    const res = await resolveAdmittedRoster(NET, provider(rows));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.roster.states?.[0]).toEqual({
      principal_id: "andreas",
      status: "ADMITTED",
      sealed: false,
      hub_authorized_at: null,
      authorship: "unchecked",
    });
  });

  it("dedupes states by principal (first-seen), ignoring rows for other networks", async () => {
    const rows: AdmissionRow[] = [
      { principal_id: "andreas", network_id: NET, status: "ADMITTED", sealed: true },
      { principal_id: "andreas", network_id: NET, status: "REVOKED" }, // dup — dropped
      { principal_id: "other", network_id: "different-net", status: "ADMITTED" }, // wrong net
    ];
    const res = await resolveAdmittedRoster(NET, provider(rows));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const states = res.roster.states ?? [];
    expect(states).toHaveLength(1);
    expect(states[0]?.status).toBe("ADMITTED"); // first-seen wins
    expect(states[0]?.sealed).toBe(true);
  });

  it("carries a pre-resolved authorship verdict through verbatim", async () => {
    const rows: AdmissionRow[] = [
      { principal_id: "andreas", network_id: NET, status: "ADMITTED", authorship: "verified" },
    ];
    const res = await resolveAdmittedRoster(NET, provider(rows));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.roster.states?.[0]?.authorship).toBe("verified");
  });
});
