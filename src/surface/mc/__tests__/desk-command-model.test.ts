import { NOT_LOCAL_CONTENT } from "../desk/source-boundary";
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McSchema } from "../../../common/types/config";
import { modelJson, modelPaths } from "../desk/classify";
import { rulingExplainer } from "../desk/ruling";
import { CommandTimeout, runModelCommand } from "../common/spawn";

describe("Desk command models", () => {
  it("accepts native helper commands for every personal helper with separate local access", () => {
    const command = { command: ["desk-codex-json", "--model", "gpt-6.1-sol"], timeoutSeconds: 120 };
    const config = McSchema.parse({ desk: { studio: { dir: "/tmp/studio", filer: command }, mail: { digest: { model: command }, waiting: { model: command } } } });
    expect(config.desk.studio?.filer).toMatchObject(command);
    expect(config.desk.mail.digest?.model).toMatchObject(command);
    expect(config.desk.mail.waiting?.model).toMatchObject(command);
    expect(McSchema.safeParse({ desk: { mail: { digest: { model: { ...command, baseUrl: "https://example.org/v1", model: "http" } } } } }).success).toBe(false);
    for (const helper of ["digest", "waiting"]) expect(McSchema.safeParse({ desk: { mail: { [helper]: { model: { ...command, local: { ...command, sourcePolicy: "cloud" } } } } } }).success).toBe(false);
    expect(McSchema.safeParse({ desk: { studio: { dir: "/tmp/fixture", filer: { ...command, local: { ...command, sourcePolicy: "cloud" } } } } }).success).toBe(false);
    expect(modelPaths({ command: ["~/bin/model", "--model", "literal", "~/scope"], timeoutSeconds: 120 }, value => value.replace("~/", "/home/fixture/"))).toMatchObject({ command: ["/home/fixture/bin/model", "--model", "literal", "/home/fixture/scope"] });
  });

  it("passes explicit system and user messages through stdin and validates stdout JSON", async () => {
    const command = [process.execPath, "-e", 'const body=await Bun.stdin.json(); console.log(JSON.stringify({system:body.messages[0].content,user:JSON.parse(body.messages[1].content)}));'];
    const call = modelJson({ command, timeoutSeconds: 5 });
    expect(await call([{ role: "system", content: "Scope fixture" }, { role: "user", content: '{"personal":true}' }], 15_000, NOT_LOCAL_CONTENT)).toEqual({ system: "Scope fixture", user: { personal: true } });
    const invalid = modelJson({ command: [process.execPath, "-e", 'console.log("not JSON")'], timeoutSeconds: 5 });
    await expect(invalid([{ role: "user", content: "synthetic" }], 15_000, NOT_LOCAL_CONTENT)).rejects.toThrow("JSON");
  });

  it("preserves raw ruling command stdin and opts native helpers into message envelopes", async () => {
    const seen: string[] = [];
    const runner = async (_argv: string[], _timeout: number, stdin: string) => { seen.push(stdin); return { code: 0, signal: null, stdout: "{}", stderr: "" }; };
    const config = { command: ["fixture"], timeoutSeconds: 5 };
    await rulingExplainer(config, fetch, runner, async () => null)("Raw ruling fixture");
    expect(seen[0]).toBe("Raw ruling fixture");
    await rulingExplainer({ ...config, commandFormat: "messages", sourcePolicy: "cloud" }, fetch, runner, async () => null)("Scoped ruling fixture");
    expect(JSON.parse(seen[1] ?? "")).toMatchObject({ sourcePolicy: "cloud", messages: [{ role: "system", content: expect.stringContaining("ruling") }, { role: "user", content: "Scoped ruling fixture" }] });
  });

  it("kills a helper's descendant on timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "desk-model-timeout-"));
    const pidFile = join(dir, "child.pid");
    try {
      const script = `const child=Bun.spawn([process.execPath,"-e","await Bun.sleep(30000)"],{stdout:"ignore",stderr:"ignore"});await Bun.write(${JSON.stringify(pidFile)},String(child.pid));await child.exited;`;
      await expect(runModelCommand([process.execPath, "-e", script], 2000)).rejects.toBeInstanceOf(CommandTimeout);
      const pid = Number(await Bun.file(pidFile).text());
      await Bun.sleep(100);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
