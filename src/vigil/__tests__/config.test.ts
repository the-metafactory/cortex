// glossary-ignore: agent, persona, run, node
import { describe, expect, test } from "bun:test";
import { AgentConfigSchema } from "../../common/types/config";
import { CortexConfigSchema } from "../../common/types/cortex-config";

const base = { principal: { id: "jc" }, agents: [{ id: "ivy", displayName: "Ivy", persona: "./ivy.md", presence: {} }], claude: {} };
const key = "run:job:harness-gate";

describe("Vigil cadence config", () => {
  test("both schemas default cadence to an empty map", () => {
    expect(CortexConfigSchema.parse(base).vigil.cadence).toEqual({});
    expect(AgentConfigSchema.parse({ claude: {}, agent: { name: "ivy", displayName: "Ivy" } }).vigil.cadence).toEqual({});
    expect(CortexConfigSchema.parse({ ...base, vigil: { enabled: true } }).vigil.cadence).toEqual({});
  });

  test("preserves positive integer millisecond overrides by full subject key", () => {
    const cadence = { [key]: 3_600_000, "state:goal:G1": 1, "run:node:ignored": 1 };
    expect(CortexConfigSchema.parse({ ...base, vigil: { cadence } }).vigil.cadence).toEqual(cadence);
  });

  test.each([0, -1, 1.5, "3600000", null, true, NaN, Infinity])("rejects invalid cadence %s and names its key", (value) => {
    const result = CortexConfigSchema.safeParse({ ...base, vigil: { cadence: { [key]: value } } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === `vigil.cadence.${key}`)).toBe(true);
      expect(result.error.message).toContain(key);
    }
  });
});

describe("Vigil fallback email config", () => {
  const email = { command: "email", account: "alerts", to: "principal@example.test" };

  test("both schemas retain the email block and default its timeout", () => {
    const vigil = { fallback: { email } };
    for (const parsed of [
      CortexConfigSchema.parse({ ...base, vigil }),
      AgentConfigSchema.parse({ claude: {}, agent: { name: "ivy", displayName: "Ivy" }, vigil }),
    ]) {
      expect(parsed.vigil.fallback?.email).toEqual({ ...email, timeout_ms: 10000 });
    }
    expect(CortexConfigSchema.parse(base).vigil.fallback).toBeUndefined();
    expect(CortexConfigSchema.parse({ ...base, vigil: { fallback: { email: { ...email, timeout_ms: 250 } } } }).vigil.fallback?.email?.timeout_ms).toBe(250);
  });

  test.each([0, -1, 1.5, "10000", null, true, NaN, Infinity])("rejects invalid timeout %s", (timeout_ms) => {
    expect(CortexConfigSchema.safeParse({ ...base, vigil: { fallback: { email: { ...email, timeout_ms } } } }).success).toBe(false);
  });

  test.each(["command", "account", "to"])("requires nonempty %s when an email block is present", (field) => {
    for (const value of ["", undefined]) {
      expect(CortexConfigSchema.safeParse({ ...base, vigil: { fallback: { email: { ...email, [field]: value } } } }).success).toBe(false);
    }
  });
});


test("result link base defaults in both config schemas and retains explicit HTTP bases", () => {
  for (const schemaInput of [
    () => CortexConfigSchema.parse(base),
    () => AgentConfigSchema.parse({ claude: {}, agent: { name: "example", displayName: "Example" } }),
  ]) expect(schemaInput().vigil.result_base_url).toBe("http://127.0.0.1:8767");
  expect(CortexConfigSchema.parse({ ...base, vigil: { result_base_url: "https://mc.example.test" } }).vigil.result_base_url).toBe("https://mc.example.test");
  for (const result_base_url of ["invalid", "javascript:alert(1)", "file:///tmp/results"]) {
    expect(CortexConfigSchema.safeParse({ ...base, vigil: { result_base_url } }).success).toBe(false);
  }
});


test("proposal filing config is shared, defaults its timeout and retains only the token env name", () => {
  const vigil = { proposal_token_env: "PRINCIPAL_PROPOSAL_TOKEN", proposal_timeout_ms: 2345 };
  const parsed = [
    CortexConfigSchema.parse({ ...base, vigil }),
    AgentConfigSchema.parse({ claude: {}, agent: { name: "ivy", displayName: "Ivy" }, vigil }),
  ];
  for (const config of parsed) expect(config.vigil).toMatchObject(vigil);
  expect(CortexConfigSchema.parse(base).vigil.proposal_timeout_ms).toBe(30_000);
  expect(CortexConfigSchema.parse(base).vigil.proposal_token_env).toBeUndefined();
  for (const proposal_timeout_ms of [0, -1, 1.5, 300_001, "1000", null, Infinity]) {
    expect(CortexConfigSchema.safeParse({ ...base, vigil: { proposal_timeout_ms } }).success).toBe(false);
  }
  for (const proposal_token_env of ["", "not an env", "1TOKEN", "TOKEN=value", null]) {
    expect(CortexConfigSchema.safeParse({ ...base, vigil: { proposal_token_env } }).success).toBe(false);
  }
});
