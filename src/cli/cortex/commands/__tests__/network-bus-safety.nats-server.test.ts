import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { encodeOperator } from "@nats-io/jwt";
import { createOperator } from "@nats-io/nkeys";

import { upsertHubLeafUser } from "../../../../common/nats/hub-leaf-authorization";
import { resolveConfigIncludes, scanForLeafnodeAuthorizationBomb } from "../network-bus-safety";

const natsServer = Bun.which("nats-server");
const dir = mkdtempSync(join(tmpdir(), "cortex-2747-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FATAL = "operator mode does not allow specifying users in leafnode config";

async function operatorStanza(): Promise<string> {
  const jwt = await encodeOperator("test-operator", createOperator());
  return `operator: ${jwt}\nresolver: MEMORY\nresolver_preload: {}\nport: -1\n`;
}

function writeConf(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(50);
  }
  return pred();
}

async function start(conf: string): Promise<{ exited: boolean; log: string }> {
  const logPath = `${conf}.log`;
  const proc = Bun.spawn([natsServer!, "-c", conf, "-l", logPath], { stdout: "ignore", stderr: "pipe" });
  const ready = await waitFor(() => {
    try {
      return readFileSync(logPath, "utf-8").includes("Server is ready");
    } catch {
      return false;
    }
  }, 3000);
  const exited = !ready && (await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]));
  const stderr = exited ? await new Response(proc.stderr).text() : "";
  if (!exited) {
    proc.kill();
    await proc.exited;
  }
  return { exited, log: stderr + (existsSync(logPath) ? readFileSync(logPath, "utf-8") : "") };
}

function guardFlags(conf: string): boolean {
  const resolved = resolveConfigIncludes(conf, {
    read: (p) => readFileSync(p, "utf-8"),
    dirname: (p) => p.slice(0, p.lastIndexOf("/")),
    join: (d, f) => join(d, f),
  });
  return scanForLeafnodeAuthorizationBomb(resolved).length > 0;
}

describe.skipIf(natsServer === null)("cortex#2747 — real nats-server in operator mode (pinned on v2.14.0)", () => {
  test.each([
    ["no listen port", ""],
    ["a listen port", "  listen: 127.0.0.1:-1\n"],
    ["only remotes", '  remotes: [ { url: "nats://127.0.0.1:1" } ]\n'],
  ])("refuses to start with the cortex-managed block and %s; the guard flags it", async (label, extra) => {
    const conf = writeConf(
      `block-${label.replace(/\W+/g, "-")}.conf`,
      (await operatorStanza()) + upsertHubLeafUser(`leafnodes {\n${extra}}\n`, "alice", "PSK"),
    );
    const run = await start(conf);
    expect(run.exited).toBe(true);
    expect(run.log).toContain(FATAL);
    expect(guardFlags(conf)).toBe(true);
  });

  test("starts with a listener and no users; the guard stays silent", async () => {
    const conf = writeConf("clean.conf", `${await operatorStanza()}leafnodes {\n  listen: 127.0.0.1:-1\n}\n`);
    const run = await start(conf);
    expect(run.exited).toBe(false);
    expect(guardFlags(conf)).toBe(false);
  });

  test("a SIGHUP reload rejects the block and keeps the server running on the old config", async () => {
    const base = await operatorStanza();
    const conf = writeConf("reload.conf", base);
    const logPath = `${conf}.log`;
    const proc = Bun.spawn([natsServer!, "-c", conf, "-l", logPath], { stdout: "ignore", stderr: "ignore" });
    try {
      const log = () => {
        try {
          return readFileSync(logPath, "utf-8");
        } catch {
          return "";
        }
      };
      expect(await waitFor(() => log().includes("Server is ready"), 3000)).toBe(true);
      writeFileSync(conf, base + upsertHubLeafUser("leafnodes {\n}\n", "alice", "PSK"));
      proc.kill("SIGHUP");
      expect(await waitFor(() => log().includes("Failed to reload"), 3000)).toBe(true);
      expect(log()).toContain(FATAL);
      expect(proc.exitCode).toBeNull();
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
