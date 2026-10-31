import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeskRoutineCatalog } from "../desk-compose";

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
