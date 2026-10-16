// glossary-ignore: agent, persona
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
