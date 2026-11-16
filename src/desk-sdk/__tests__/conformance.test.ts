import { describe, expect, test } from "bun:test";
import { INVITATION_OPEN_VECTORS, REPLIES_TO_VECTORS, invitationOpen, repliesTo, runDeskRuleVectors } from "../index";

describe("desk-sdk conformance vectors", () => {
  test("the reference rules pass every vector", () => {
    expect(runDeskRuleVectors({ invitationOpen, repliesTo })).toEqual([]);
  });

  test("each rule has at least six vectors", () => {
    expect(INVITATION_OPEN_VECTORS.length).toBeGreaterThanOrEqual(6);
    expect(REPLIES_TO_VECTORS.length).toBeGreaterThanOrEqual(6);
  });

  test("an implementation that ignores recurring fails a vector", () => {
    const ignoresRecurring: typeof invitationOpen = (inv, answered, now) => invitationOpen({ ...inv, recurring: false }, answered, now);
    expect(runDeskRuleVectors({ invitationOpen: ignoresRecurring, repliesTo }).map((f) => f.name)).toContain("a recurring past invitation is open");
  });

  test("an implementation that counts self-sent mail as a reply fails a vector", () => {
    const countsSelf: typeof repliesTo = (sent, c) => repliesTo({ ...sent, from: "nobody@invalid" }, c);
    expect(runDeskRuleVectors({ invitationOpen, repliesTo: countsSelf }).length).toBeGreaterThan(0);
  });
});
