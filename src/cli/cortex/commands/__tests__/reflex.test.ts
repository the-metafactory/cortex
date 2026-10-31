import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { reflexTargets } from "../reflex";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-reflex-targets-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const base = { principal: { id: "example" }, stack: { id: "example/default" }, claude: {}, agents: [{ id: "test", displayName: "Test", persona: "./test.md", presence: {} }] };
const target = (ref: string) => ({ target: ref, capability: "process.run", assistant: "cortex", handler: "process", process: "noop" });
function single(refs: string[]) {
  const path = join(dir, "cortex.yaml");
  writeFileSync(path, stringify({ ...base, reflex_activation: { targets: refs.map(target) } }), { mode: 0o600 });
  return path;
}

describe("configured Reflex target discovery", () => {
  test("prints references only and preserves configuration bytes", () => {
    const path = single(["@example/z", "@example/a"]);
    const before = readFileSync(path, "utf8");
    const result = reflexTargets(path, true);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ targets: ["@example/a", "@example/z"] });
    expect(result.stdout).not.toContain("process.run");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("uses the real split-config composer and later target layer", () => {
    mkdirSync(join(dir, "system"));
    mkdirSync(join(dir, "stacks"));
    writeFileSync(join(dir, "system/system.yaml"), stringify({ ...base, reflex_activation: { targets: [target("@example/old")] } }));
    writeFileSync(join(dir, "stacks/default.yaml"), stringify({ reflex_activation: { targets: [target("@example/current")] } }));
    expect(JSON.parse(reflexTargets(join(dir, "cortex.yaml"), true).stdout)).toEqual({ targets: ["@example/current"] });
  });

  test("refuses invalid config without leaking its contents", () => {
    const path = single([]);
    writeFileSync(path, "principal: {id: private-secret-string}\nreflex_activation: invalid");
    const result = reflexTargets(path, true);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("private-secret-string");
  });

  test("production CLI has strict JSON stdout despite startup and loader diagnostics", async () => {
    const path = single(["@example/noop"]);
    const child = Bun.spawn([process.execPath, "src/cortex.ts", "reflex", "targets", "--config", path, "--json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ targets: ["@example/noop"] });
    expect(stderr).toContain("prompt-filter:");
    expect(stderr).toContain("no networks loaded");
  });
});
