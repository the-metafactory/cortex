import { describe, expect, test } from "bun:test";
import { buildProcessEnv } from "../process-env";
import type { FiredActivation } from "../reflex-activation-listener";

const PARENT = {
  HOME: "/home/cortex",
  PATH: "/usr/bin",
  PULSE_PRINCIPAL: "jc",
  PULSE_STACK: "default",
  PULSE_NATS_URL: "nats://localhost:4222",
  PULSE_NATS_CREDS: "/etc/pulse.creds",
  SECRET_X: "secret",
};
const ACTIVATION: FiredActivation = {
  target: "@jc/process",
  payload: {},
  decisionId: "d1",
  correlationId: "c1",
  classification: "local",
  serves: { goal: "G1", node: "n1" },
};

describe("buildProcessEnv", () => {
  test("allow-list includes Pulse connection variables and fire metadata only", () => {
    expect(buildProcessEnv({ spec: { env: ["HOME", "PATH"] }, activation: ACTIVATION, parentEnv: PARENT })).toEqual({
      HOME: PARENT.HOME,
      PATH: PARENT.PATH,
      PULSE_PRINCIPAL: PARENT.PULSE_PRINCIPAL,
      PULSE_STACK: PARENT.PULSE_STACK,
      PULSE_NATS_URL: PARENT.PULSE_NATS_URL,
      PULSE_NATS_CREDS: PARENT.PULSE_NATS_CREDS,
      MF_SERVES_GOAL: "G1",
      MF_SERVES_NODE: "n1",
      MF_CORRELATION_ID: "c1",
    });
  });

  test("no allow-list copies the full parent env and overrides inherited metadata", () => {
    const parentEnv = { ...PARENT, MF_SERVES_GOAL: "old-goal", MF_SERVES_NODE: "old-node", MF_CORRELATION_ID: "old-correlation" };
    const before = { ...parentEnv };
    expect(buildProcessEnv({ spec: {}, activation: ACTIVATION, parentEnv })).toEqual({
      ...PARENT, MF_SERVES_GOAL: "G1", MF_SERVES_NODE: "n1", MF_CORRELATION_ID: "c1",
    });
    expect(parentEnv).toEqual(before);
    expect(ACTIVATION.serves).toEqual({ goal: "G1", node: "n1" });
  });

  for (const env of [undefined, ["HOME", "MF_SERVES_GOAL", "MF_SERVES_NODE", "MF_CORRELATION_ID"]]) {
    test(`missing fire metadata clears inherited values (${env ? "allow-list" : "full env"})`, () => {
      const parentEnv = { HOME: "/h", MF_SERVES_GOAL: "old-goal", MF_SERVES_NODE: "old-node", MF_CORRELATION_ID: "old-correlation" };
      expect(buildProcessEnv({ spec: { env }, activation: { ...ACTIVATION, serves: undefined, correlationId: undefined }, parentEnv })).toEqual({ HOME: "/h" });
    });

    test(`goal-only fire leaves inherited node absent (${env ? "allow-list" : "full env"})`, () => {
      const parentEnv = { HOME: "/h", MF_SERVES_NODE: "old-node" };
      expect(buildProcessEnv({ spec: { env }, activation: { ...ACTIVATION, serves: { goal: "G1" } }, parentEnv })).toEqual({
        HOME: "/h", MF_SERVES_GOAL: "G1", MF_CORRELATION_ID: "c1",
      });
    });

    test(`node-only fire leaves inherited goal absent (${env ? "allow-list" : "full env"})`, () => {
      const parentEnv = { HOME: "/h", MF_SERVES_GOAL: "old-goal" };
      expect(buildProcessEnv({ spec: { env }, activation: { ...ACTIVATION, serves: { node: "n1" } }, parentEnv })).toEqual({
        HOME: "/h", MF_SERVES_NODE: "n1", MF_CORRELATION_ID: "c1",
      });
    });
  }

  test("empty allow-list still passes available Pulse variables; unset variables are absent", () => {
    expect(buildProcessEnv({ spec: { env: [] }, activation: { ...ACTIVATION, serves: undefined, correlationId: undefined }, parentEnv: {
      HOME: "/h", PULSE_PRINCIPAL: "jc", PULSE_NATS_CREDS: undefined,
    } })).toEqual({ PULSE_PRINCIPAL: "jc" });
  });

  test("undefined parent values are omitted with and without an allow-list", () => {
    for (const env of [undefined, ["HOME", "MISSING", "PULSE_NATS_URL"]]) {
      expect(buildProcessEnv({ spec: { env }, activation: { ...ACTIVATION, serves: undefined, correlationId: undefined }, parentEnv: {
        HOME: "/h", MISSING: undefined, PULSE_NATS_URL: undefined,
      } })).toEqual({ HOME: "/h" });
    }
  });
});
