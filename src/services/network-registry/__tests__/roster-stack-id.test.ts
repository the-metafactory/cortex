/**
 * cortex#1852 half (A) — the roster must PROJECT each member's `stack_id`,
 * derived from the principal record exactly as the admission reads already do
 * (cortex#1723), so the client never has to invent `{principal}/default`.
 *
 * Derivation posture (inherited verbatim from `deriveAdmissionStackId`):
 *   - join `row.peer_pubkey` against the principal's LIVE (non-retired) stacks
 *   - emit `stack_id` ONLY on a unique match
 *   - on no match / ambiguous match: OMIT the key. Never `null`, never a guess.
 */

import { describe, test, expect } from "bun:test";
import { rosterFromAdmissions } from "../src/store";
import type { AdmissionRequest, Capability, PrincipalRecord, StackIdentity } from "../src/types";

const NETWORK = "metafactory";

const PUBKEY = {
  andreasRoot: "AAAAandreas_root_pubkey_base64_padding_44char=",
  andreasMetaFactory: "AAAAandreas_meta_factory_stack_pubkey_44char=",
  jcRoot: "BBBBjc_root_pubkey_base64_padding_value_44ch=",
  jcDefault: "BBBBjc_default_stack_pubkey_base64_val_44char=",
  jcClawbox: "BBBBjc_clawbox_stack_pubkey_base64_val_44char=",
  unknown: "ZZZZunknown_pubkey_matching_no_live_stack_44=",
} as const;

function stack(stackId: string, stackPubkey: string, retiredAt?: string): StackIdentity {
  return { stack_id: stackId, stack_pubkey: stackPubkey, ...(retiredAt !== undefined && { retired_at: retiredAt }) };
}

function principal(
  principalId: string,
  principalPubkey: string,
  stacks: StackIdentity[],
  capabilities: Capability[] = [],
): PrincipalRecord {
  return {
    principal_id: principalId,
    principal_pubkey: principalPubkey,
    stacks,
    capabilities,
    updated_at: "2026-07-10T00:00:00.000Z",
  };
}

function admission(principalId: string, peerPubkey: string): AdmissionRequest {
  return {
    request_id: `req-${principalId}`,
    principal_id: principalId,
    peer_pubkey: peerPubkey,
    requested_scope: "federation",
    network_id: NETWORK,
    status: "ADMITTED",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    granted_by: "admin",
    sealed_secret: null,
    hub_authorized_at: null,
  };
}

/** The single member of a one-member roster. */
function onlyMember(admitted: AdmissionRequest[], principals: PrincipalRecord[]) {
  const roster = rosterFromAdmissions(admitted, principals, NETWORK);
  expect(roster.members).toHaveLength(1);
  return roster.members[0]!;
}

describe("cortex#1852 — roster projects a derived stack_id", () => {
  test("single live stack with a NON-default slug → stack_id is projected", () => {
    const member = onlyMember(
      [admission("andreas", PUBKEY.andreasMetaFactory)],
      [
        principal("andreas", PUBKEY.andreasRoot, [
          stack("andreas/meta-factory", PUBKEY.andreasMetaFactory),
        ]),
      ],
    );
    // The exact bug: this used to be absent, and the client invented "andreas/default".
    expect(member.stack_id).toBe("andreas/meta-factory");
  });

  test("TWO live stacks → peer_pubkey selects the right one uniquely", () => {
    const principals = [
      principal("jc", PUBKEY.jcRoot, [
        stack("jc/default", PUBKEY.jcDefault),
        stack("jc/clawbox", PUBKEY.jcClawbox),
      ]),
    ];

    expect(onlyMember([admission("jc", PUBKEY.jcDefault)], principals).stack_id).toBe("jc/default");
    expect(onlyMember([admission("jc", PUBKEY.jcClawbox)], principals).stack_id).toBe("jc/clawbox");
  });

  test("AMBIGUOUS (pubkey matches >1 live stack) → stack_id key is ABSENT, never guessed", () => {
    const member = onlyMember(
      [admission("jc", PUBKEY.jcDefault)],
      [
        principal("jc", PUBKEY.jcRoot, [
          stack("jc/default", PUBKEY.jcDefault),
          stack("jc/clone", PUBKEY.jcDefault), // same pubkey ⇒ ambiguous
        ]),
      ],
    );
    expect("stack_id" in member).toBe(false);
    expect(member.stack_id).toBeUndefined();
  });

  test("NO match → stack_id key is ABSENT (no `{principal}/default` fabrication, no null)", () => {
    const member = onlyMember(
      [admission("andreas", PUBKEY.unknown)],
      [
        principal("andreas", PUBKEY.andreasRoot, [
          stack("andreas/meta-factory", PUBKEY.andreasMetaFactory),
        ]),
      ],
    );
    expect("stack_id" in member).toBe(false);
    // Neither the key (⇒ never serialised as `"stack_id":null`) nor a guess.
    expect(JSON.stringify(member)).not.toContain("stack_id");
    expect(JSON.stringify(member)).not.toContain("andreas/default");
  });

  test("a RETIRED stack is excluded from the match", () => {
    const member = onlyMember(
      [admission("andreas", PUBKEY.andreasMetaFactory)],
      [
        principal("andreas", PUBKEY.andreasRoot, [
          stack("andreas/meta-factory", PUBKEY.andreasMetaFactory, "2026-07-01T00:00:00.000Z"),
        ]),
      ],
    );
    expect("stack_id" in member).toBe(false);
  });

  test("a retired stack does not make a live one ambiguous", () => {
    const member = onlyMember(
      [admission("andreas", PUBKEY.andreasMetaFactory)],
      [
        principal("andreas", PUBKEY.andreasRoot, [
          stack("andreas/old", PUBKEY.andreasMetaFactory, "2026-07-01T00:00:00.000Z"),
          stack("andreas/meta-factory", PUBKEY.andreasMetaFactory),
        ]),
      ],
    );
    expect(member.stack_id).toBe("andreas/meta-factory");
  });

  test("enrichment is ADDITIVE — existing member fields are untouched", () => {
    const roster = rosterFromAdmissions(
      [{ ...admission("andreas", PUBKEY.andreasMetaFactory), sealed_secret: "ciphertext" }],
      [
        principal(
          "andreas",
          PUBKEY.andreasRoot,
          [stack("andreas/meta-factory", PUBKEY.andreasMetaFactory)],
          [{ id: "dev.implement", networks: [NETWORK] }],
        ),
      ],
      NETWORK,
    );
    expect(roster.members[0]).toEqual({
      principal_id: "andreas",
      principal_pubkey: PUBKEY.andreasRoot,
      capabilities: ["dev.implement"],
      admission_state: "ADMITTED",
      sealed: true, // boolean DELIVERY signal — never the ciphertext
      hub_authorized_at: null,
      stack_id: "andreas/meta-factory",
    });
  });

  test("the andreas⇄jc regression: both members carry their REAL stack ids", () => {
    const roster = rosterFromAdmissions(
      [admission("andreas", PUBKEY.andreasMetaFactory), admission("jc", PUBKEY.jcDefault)],
      [
        principal("andreas", PUBKEY.andreasRoot, [
          stack("andreas/meta-factory", PUBKEY.andreasMetaFactory),
        ]),
        principal("jc", PUBKEY.jcRoot, [stack("jc/default", PUBKEY.jcDefault)]),
      ],
      NETWORK,
    );
    expect(roster.members.map((m) => m.stack_id)).toEqual(["andreas/meta-factory", "jc/default"]);
  });
});
