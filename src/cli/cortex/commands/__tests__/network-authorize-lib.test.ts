/**
 * cortex#1498 (epic #1479 follow-up) — `cortex network authorize` orchestrator
 * tests (fake ports).
 *
 * Proves the trust-path behaviours over injected ports:
 *   - dry-run (default) resolves the ADMITTED row but posts NOTHING
 *   - --apply POSTs the authorize claim onto the resolved row
 *   - no ADMITTED row → ok:false, no mutation, an actionable reason
 *   - a delivery-port failure surfaces as ok:false with the error text
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { nkeyToBase64Pubkey } from "../../../../common/registry/encoding";
import { runNetworkAuthorize, type AuthorizeInputs } from "../network-authorize-lib";
import type { NetworkAuthorizePorts } from "../network-authorize-ports";

function makePorts(admitted?: { request_id: string; principal_id: string }): {
  ports: NetworkAuthorizePorts;
  posted: string[];
} {
  const posted: string[] = [];
  const ports: NetworkAuthorizePorts = {
    admission: {
      findAdmittedRow: async () => admitted,
    },
    delivery: {
      postAuthorize: async (requestId: string) => {
        posted.push(requestId);
      },
    },
  };
  return { ports, posted };
}

const MEMBER_PUBKEY = nkeyToBase64Pubkey(createUser().getPublicKey())!;

describe("runNetworkAuthorize", () => {
  test("dry-run (default) resolves the row but posts NOTHING", async () => {
    const { ports, posted } = makePorts({ request_id: "req-1", principal_id: "alice" });
    const inputs: AuthorizeInputs = { networkId: "metafactory", memberPubkey: MEMBER_PUBKEY, apply: false };
    const report = await runNetworkAuthorize(inputs, ports);
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(false);
    expect(report.data.request_id).toBe("req-1");
    expect(posted).toEqual([]);
    expect(report.steps.some((s) => s.includes("would:"))).toBe(true);
  });

  test("--apply POSTs the authorize claim onto the resolved row", async () => {
    const { ports, posted } = makePorts({ request_id: "req-1", principal_id: "alice" });
    const inputs: AuthorizeInputs = { networkId: "metafactory", memberPubkey: MEMBER_PUBKEY, apply: true };
    const report = await runNetworkAuthorize(inputs, ports);
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);
    expect(posted).toEqual(["req-1"]);
  });

  test("no ADMITTED row → ok:false, no mutation, actionable reason", async () => {
    const { ports, posted } = makePorts(undefined);
    const inputs: AuthorizeInputs = { networkId: "metafactory", memberPubkey: MEMBER_PUBKEY, apply: true };
    const report = await runNetworkAuthorize(inputs, ports);
    expect(report.ok).toBe(false);
    expect(report.applied).toBe(false);
    expect(posted).toEqual([]);
    expect(report.reason).toContain("no ADMITTED admission row");
  });

  test("delivery failure surfaces as ok:false with the error text", async () => {
    const ports: NetworkAuthorizePorts = {
      admission: { findAdmittedRow: async () => ({ request_id: "req-1", principal_id: "alice" }) },
      delivery: {
        postAuthorize: async () => {
          throw new Error("registry rejected authorize (HTTP 403)");
        },
      },
    };
    const inputs: AuthorizeInputs = { networkId: "metafactory", memberPubkey: MEMBER_PUBKEY, apply: true };
    const report = await runNetworkAuthorize(inputs, ports);
    expect(report.ok).toBe(false);
    expect(report.reason).toContain("registry rejected authorize");
  });
});
