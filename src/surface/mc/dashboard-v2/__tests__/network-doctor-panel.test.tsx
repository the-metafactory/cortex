/**
 * FLG-3 (docs/plan-mc-future-state.md §4.D) — DoctorReport render tests.
 *
 * The report is a PURE component (props-only, no hooks), so it renders under
 * `renderToStaticMarkup`. These assert the acceptance: the renderer shows
 * status / fix / owner per leg (including the two plan-named legs
 * `sealed-secret-hub-authorized` + `peer-reachable:<p>`) + the aggregate
 * verdict, and that verdict strings render VERBATIM (sourced, never re-derived).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DoctorReport } from "../components/network-doctor-panel";
import type { NetworkDoctorDTO } from "../hooks/use-doctor";

function sample(): NetworkDoctorDTO {
  return {
    network_id: "research",
    verdict: "degraded",
    checks: [
      {
        id: "config-network",
        title: 'network "research" configured',
        status: "pass",
        detail: "2 peer(s), 3 accept_subjects",
        fix: null,
        owner: "member",
      },
      {
        id: "sealed-secret-hub-authorized",
        title: "registry sealed-secret ⟷ hub authorization (Pair 3)",
        status: "skip",
        detail: "not implemented from the member side (ADR-0018 Q1)",
        fix: null,
        owner: "hub-owner",
      },
      {
        id: "peer-reachable:jc/default",
        title: "peer reachable: jc/default",
        status: "fail",
        detail: "no echo from jc/default within the probe timeout",
        fix: "peer/hub — peer offline, its leaf is down, or the hub is partitioned",
        owner: "peer",
      },
    ],
  };
}

describe("DoctorReport", () => {
  it("renders the aggregate verdict verbatim", () => {
    const html = renderToStaticMarkup(
      createElement(DoctorReport, { report: sample() }),
    );
    expect(html).toContain('data-verdict="degraded"');
    expect(html).toContain(">degraded<");
  });

  it("renders every leg with its status + owner as data attributes", () => {
    const html = renderToStaticMarkup(
      createElement(DoctorReport, { report: sample() }),
    );
    // status/owner surfaced as stable tokens for automation/tests.
    expect(html).toContain('data-leg="config-network"');
    expect(html).toContain('data-status="pass"');
    expect(html).toContain('data-status="skip"');
    expect(html).toContain('data-status="fail"');
    expect(html).toContain('data-owner="peer"');
    expect(html).toContain('data-owner="hub-owner"');
  });

  it("renders the two plan-named legs (sealed-secret + peer-reachable)", () => {
    const html = renderToStaticMarkup(
      createElement(DoctorReport, { report: sample() }),
    );
    expect(html).toContain('data-leg="sealed-secret-hub-authorized"');
    expect(html).toContain('data-leg="peer-reachable:jc/default"');
  });

  it("renders the fix + its owner label only for legs that have a fix", () => {
    const html = renderToStaticMarkup(
      createElement(DoctorReport, { report: sample() }),
    );
    // The failing peer leg shows its fix with the owner label ("peer").
    expect(html).toContain("fix (peer):");
    expect(html).toContain("peer offline");
    // The passing config leg has no fix → no "fix (" prefix for member here.
    expect(html).not.toContain("fix (you (member)):");
  });
});
