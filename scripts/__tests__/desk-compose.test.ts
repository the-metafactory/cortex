import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardRoutineEdit, loadDeskRoutineCatalog } from "../desk-compose";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "desk-catalog-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("uses only exact active snapshot entries with providers supported by pulse-flow", async () => {
  const packages = [];
  for (const [name, status, requires] of [
    ["A_READ", "active", ["shell"]], ["A_MODEL", "active", ["llm"]], ["A_AGENT", "active", ["agent"]], ["A_DISABLED", "disabled", []],
  ] satisfies [string, string, string[]][]) {
    const installPath = join(root, name);
    await mkdir(installPath);
    await writeFile(join(installPath, "action.json"), JSON.stringify({ name, description: "Test action", input: {}, output: {}, requires }));
    packages.push({ name, type: "action", status, installPath });
  }
  const file = join(root, "inventory.json");
  await writeFile(file, JSON.stringify({ packages }));
  expect((await loadDeskRoutineCatalog(file)).map((a) => a.name)).toEqual(["A_READ"]);
  const selected = packages[0];
  if (!selected) throw new Error("Fixture inventory is empty");
  await writeFile(join(selected.installPath, "action.json"), JSON.stringify({ name: "A_COUNTERFEIT", description: "Mismatch" }));
  await expect(loadDeskRoutineCatalog(file)).rejects.toThrow("identity mismatch");
});

it("forwards redacted routine proposals through the same configured model and credential reference", async () => {
  let argv: string[] = [];
  let timeout = 0;
  const options = { pulseBin: "configured-pulse", modelUrl: "https://model.example/v1", model: "configured-model", apiKeyEnv: "EXISTING_MODEL_KEY", request: "use three attempts", routineEdit: JSON.stringify({ name: "F_TEST", steps: [], privateExtra: "must-be-removed" }) };
  const result = await forwardRoutineEdit(options, (args, _stdin, ms) => {
    argv = args;
    timeout = ms;
    return Promise.resolve({ code: 0, stdout: JSON.stringify({ status: "edit", patches: [] }), stderr: "" });
  });
  expect(result).toEqual({ status: "edit", patches: [] });
  expect(argv).toContain("configured-model");
  expect(argv).toContain("https://model.example/v1");
  expect(argv).toContain("EXISTING_MODEL_KEY");
  expect(argv.join(" ")).not.toContain("must-be-removed");
  expect(argv[argv.indexOf("--routine-edit") + 1]).toBe(JSON.stringify({ name: "F_TEST", steps: [] }));
  expect(timeout).toBe(120000);
  await expect(forwardRoutineEdit({ ...options, routineEdit: "x".repeat(262145) })).rejects.toThrow("size limit");
  await expect(forwardRoutineEdit(options, () => Promise.resolve({ code: 0, stdout: "x".repeat(65537), stderr: "" }))).rejects.toThrow("size limit");
  await expect(forwardRoutineEdit(options, () => Promise.resolve({ code: 1, stdout: "private model output", stderr: "private stderr" }))).rejects.toThrow("could not prepare a valid edit");
  await expect(forwardRoutineEdit(options, () => Promise.resolve({ code: 0, stdout: "private invalid output", stderr: "" }))).rejects.toThrow("invalid parameter proposal");
});
