import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSE_CALL_TIMEOUT_MS, COMPOSE_MAX_TOKENS, composeDeskRoutine, forwardRoutineEdit, loadDeskRoutineCatalog } from "../desk-compose";
import { RoutineOptionsSchema, type RoutineOptions } from "../../src/common/types/desk-routines";
import { initDatabase } from "../../src/surface/mc/db/init";
import { buildRoutineCard } from "../../src/surface/mc/desk/routines";

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
  expect(timeout).toBe(COMPOSE_CALL_TIMEOUT_MS);
  await expect(forwardRoutineEdit({ ...options, routineEdit: "x".repeat(262145) })).rejects.toThrow("size limit");
  await expect(forwardRoutineEdit(options, () => Promise.resolve({ code: 0, stdout: "x".repeat(65537), stderr: "" }))).rejects.toThrow("size limit");
  await expect(forwardRoutineEdit(options, () => Promise.resolve({ code: 1, stdout: "private model output", stderr: "private stderr" }))).rejects.toThrow("could not prepare a valid edit");
  await expect(forwardRoutineEdit(options, () => Promise.resolve({ code: 0, stdout: "private invalid output", stderr: "" }))).rejects.toThrow("invalid parameter proposal");
});

describe("a Desk compose through the real command", () => {
  const MAIL_SEND = { name: "A_MAIL_SEND", description: "Send one mail", input: { subject: { type: "string", required: true }, body: { type: "string", required: true } }, output: { sent: { type: "boolean" } }, tags: ["email", "send", "write"], effect: "write" };
  const MAILS_SOMEONE = "```yaml\nname: F_MAIL\nactions:\n  - agent: # sovereignty: A, residency: CH\n      name: subject\n      capability: compose.judgment\n      prompt: \"Subject for {scenario}\"\n      collect: subject\n      returns: string\n  - agent: # sovereignty: A, residency: CH\n      name: body\n      capability: compose.judgment\n      prompt: \"Body for {subject}\"\n      collect: body\n      returns: string\n  - A_MAIL_SEND # sovereignty: D, residency: CH\n```\nA summary.";
  const seen: { maxTokens: unknown }[] = [];
  let model: ReturnType<typeof Bun.serve>;
  let options: RoutineOptions;

  beforeEach(async () => {
    seen.length = 0;
    model = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = await request.json() as { max_tokens: unknown; messages: { content: string }[] };
        seen.push({ maxTokens: body.max_tokens });
        const readsDelivery = body.messages[0]?.content.startsWith("Read a routine request");
        const content = readsDelivery ? JSON.stringify({ channels: ["email"], send: true, mailsSomeoneElse: true }) : MAILS_SOMEONE;
        return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
      },
    });
    const installPath = join(root, "A_MAIL_SEND");
    await mkdir(installPath);
    await writeFile(join(installPath, "action.json"), JSON.stringify(MAIL_SEND));
    const catalogFile = join(root, "inventory.json");
    await writeFile(catalogFile, JSON.stringify({ packages: [{ name: "A_MAIL_SEND", type: "action", status: "active", installPath }] }));
    options = RoutineOptionsSchema.parse({
      composer: ["/usr/bin/env", "FAKE_MODEL_KEY=none", process.execPath, join(import.meta.dir, "..", "desk-compose.ts"), "--catalog-file", catalogFile, "--model-url", `http://127.0.0.1:${model.port}/v1`, "--model", "test-model", "--api-key-env", "FAKE_MODEL_KEY"],
      reflex: ["reflex"], target: "@test/pulse-flow", timeZone: "UTC",
    });
  });
  afterEach(() => { void model.stop(true); });

  it("an impossible delivery yields a no-match card with no Confirm, and the model is never asked to compose", async () => {
    const db = initDatabase(":memory:");
    const card = await buildRoutineCard(db, "every morning at 8, mail this to someone-else@example.com", options, Date.now());
    db.close();
    expect(card).toMatchObject({ kind: "routine", unwritable: true, problem: expect.stringContaining("only your own configured addresses") });
    expect(card.fields.proposalId).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxTokens).toBe(COMPOSE_MAX_TOKENS);
  });
});

it("holds the Desk's compose to its delivery", async () => {
  let asked = 0;
  const result = await composeDeskRoutine("mail Bob the digest", [], async (_prompt, llmOptions) => {
    asked += 1;
    return { text: llmOptions?.json ? JSON.stringify({ channels: ["email"], send: true, mailsSomeoneElse: false }) : "unused" };
  });
  expect(result).toMatchObject({ status: "no-match" });
  expect(asked).toBe(1);
});
