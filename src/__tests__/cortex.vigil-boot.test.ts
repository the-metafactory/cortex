import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { AgentConfigSchema } from "../common/types/config";
import { startCortex } from "../cortex";
import type { MyelinRuntime, MyelinSubscribePullOpts } from "../bus/myelin/runtime";
import type { MyelinSubscriber } from "../bus/myelin/subscriber";
import { createFakeJetStream } from "../bus/jetstream/__tests__/fake-jetstream";
import { KEY, SUBJECT, ledgerEnvelope } from "../vigil/__tests__/fixtures";

describe("cortex Vigil boot/drain wiring", () => {
  test("opens MC before subscribing and drains Vigil while its DB is open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-vigil-boot-"));
    const dbPath = join(dir, "mc.db");
    const mcConfigPath = join(dir, "mc.yaml");
    const agentsDir = join(dir, "agents.d");
    mkdirSync(agentsDir);
    writeFileSync(mcConfigPath, "hooks:\n  streamPath: " + join(dir, "hooks.jsonl") + "\n");
    const fake = createFakeJetStream();
    const calls: MyelinSubscribePullOpts[] = [];
    const stopped: string[] = [];
    let handler!: MyelinSubscribePullOpts;
    const runtime: MyelinRuntime = {
      enabled: true, publish: async () => {}, onEnvelope: () => ({ unregister: () => {} }),
      jetstreamManager: async () => fake.jsm,
      subscribePull: (opts) => {
        calls.push(opts);
        if (opts.stream === "LEDGER") handler = opts;
        return { ready: Promise.resolve(), stop: async () => {
          if (opts.stream === "LEDGER") {
            // A final in-flight delivery must still be able to commit on drain.
            await opts.onEnvelope(ledgerEnvelope({ outcome: "succeeded" }), SUBJECT);
            stopped.push("vigil");
          }
        } } as unknown as MyelinSubscriber;
      },
      stop: async () => { stopped.push("runtime"); },
    };
    const config = AgentConfigSchema.parse({
      agent: { name: "ivy", displayName: "Ivy" }, claude: {},
      paths: { publishedEventsDir: join(dir, "published") },
      mc: { enabled: true, server: { enabled: false }, dbPath, configPath: mcConfigPath, aggregateLocalStacks: { enabled: false } },
      vigil: { enabled: true },
    });
    let handle: Awaited<ReturnType<typeof startCortex>> | undefined;
    try {
      handle = await startCortex(config, {
        disableConfigWatcher: true, disableAgentsWatcher: true, disableOutboundPoller: true,
        agentsDir, inlineAgents: [], injectRuntime: runtime, principal: { id: "jc" },
      });
      expect(calls.filter((opts) => opts.stream === "LEDGER")).toHaveLength(1);
      await handler.onEnvelope(ledgerEnvelope(), SUBJECT);
      const read = new Database(dbPath, { readonly: true });
      try { expect(read.query("SELECT value FROM vigil_subjects WHERE subject_key = ?").get(KEY)).toEqual({ value: "failed" }); }
      finally { read.close(); }
      await handle.stop();
      expect(stopped).toEqual(["vigil", "runtime"]);
      expect(handle.lastShutdownAbandoned).toEqual([]);
      const after = new Database(dbPath, { readonly: true });
      try { expect(after.query("SELECT value FROM vigil_subjects WHERE subject_key = ?").get(KEY)).toEqual({ value: "succeeded" }); }
      finally { after.close(); }
    } finally {
      await handle?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
