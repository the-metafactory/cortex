import { describe, expect, test } from "bun:test";
import * as bus from "@the-metafactory/cortex/bus";
import {
  admitOfferedDispatch,
  type AdmitOfferedDispatchInput,
  type GateFloorContext,
  type GateFloorDecision,
  type Offering,
  type OfferScope,
  type SigningMode,
} from "@the-metafactory/cortex/bus";
import { admitOfferedDispatch as internalAdmitOfferedDispatch } from "../admit-offered-dispatch";

const LOCAL_CONTEXT: GateFloorContext = {
  signed: false,
  peerInNetwork: false,
  surfaceVerified: false,
  surfacePredicatePassed: false,
  complianceOk: true,
  rateOk: true,
};

describe("public bus barrel: admitOfferedDispatch", () => {
  test("exports the existing evaluator by reference", () => {
    expect(admitOfferedDispatch).toBe(internalAdmitOfferedDispatch);
  });

  test("a consumer can call it with only the public types", () => {
    const arrivedScope: OfferScope = "local";
    const signing: SigningMode = "off";
    const offerings: readonly Offering[] | undefined = undefined;
    const input: AdmitOfferedDispatchInput = {
      capability: "synthetic.capability",
      offerings,
      arrivedScope,
      signing,
      ctx: LOCAL_CONTEXT,
    };
    const decision: GateFloorDecision = admitOfferedDispatch(input);
    expect(decision).toEqual({ admit: true });
  });

  test("does not widen the barrel past the named exports", () => {
    const exported = Object.keys(bus);
    expect(exported).toContain("admitOfferedDispatch");
    for (const internal of [
      "gateFloorForScope",
      "resolveOffering",
      "resolveSigningKnobs",
      "DEFAULT_RATE_RETRY_AFTER_MS",
      "OfferingSchema",
    ]) {
      expect(exported).not.toContain(internal);
    }
  });
});
