import { expect, mock, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "nats";
import { stringify } from "yaml";
import { natsServerBinary, startServer, waitFor } from "../../__tests__/two-domain-broker";
import { createLedgerStream } from "../ledger-stream";
import { ledgerArchiveDir, readLedgerArchive, startLedgerArchive } from "../ledger-archive";
import { LEDGER_STREAM, provisionLedgerStream } from "../provision";
import { loadConfigWithAgents } from "../../../common/config/loader";
import { verifyArchiveCommand } from "../../../cli/cortex/commands/ledger";
import { startMyelinRuntime } from "../../myelin/runtime";

test.skipIf(!natsServerBinary)("real JetStream archives through the runtime, restarts and verifies through the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-ledger-live-"));
  const server = await startServer(root, "archive");
  const nc = await connect({ servers: server.url, reconnect: false });
  const directory = join(root, "archive-files");
  const configPath = join(root, "default.yaml");
  const error = mock((_message: string) => {});
  let archive: Awaited<ReturnType<typeof startLedgerArchive>> | undefined;
  let runtime: Awaited<ReturnType<typeof startMyelinRuntime>> | undefined;
  try {
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();
    await provisionLedgerStream({ jsm, principal: "example" });
    const subject = "local.example.default.execution.run.finished";
    await js.publish(subject, new TextEncoder().encode('{ "id": "first" }'));
    await js.publish("local.example.work.execution.run.finished", new Uint8Array([0, 255, 10]));
    await writeFile(configPath, stringify({
      principal: { id: "example" },
      agents: [{ id: "archiver", displayName: "Archiver", persona: "./persona.md", roles: [], trust: [], presence: {} }],
      claude: {}, nats: { url: server.url, subjects: [] }, ledger: { archive_dir: directory },
    }), { mode: 0o600 });
    const { config } = loadConfigWithAgents(configPath);
    expect(config.ledger.archive_dir).toBe(directory);
    expect(ledgerArchiveDir(config.ledger.archive_dir)).toBe(directory);
    runtime = await startMyelinRuntime(config, { principal: "example", stack: "default" });
    const stream = await runtime.ledgerStream?.();
    if (!stream) throw new Error("Runtime did not expose the ledger stream");
    archive = await startLedgerArchive({ directory, stream, log: { error } });
    await waitFor("two archived deliveries", () => readLedgerArchive(directory).size === 2);
    await archive.stop();
    const readRows = async () => {
      const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
      return (await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")))).join("");
    };
    const firstRows = await readRows();
    expect(firstRows.trim().split("\n")).toHaveLength(2);
    const rows = firstRows.trim().split("\n").map((line: string) => JSON.parse(line));
    expect(Buffer.from(rows[1].data, "base64")).toEqual(Buffer.from([0, 255, 10]));
    await js.publish(subject, new TextEncoder().encode('{"id":"third"}'));
    expect(await verifyArchiveCommand(configPath)).toMatchObject({ exitCode: 1, stdout: expect.stringContaining("Missing 3-3 (still held by stream)") });
    archive = await startLedgerArchive({ directory, stream, log: { error } });
    await waitFor("restart catches up", () => readLedgerArchive(directory).size === 3);
    const result = await verifyArchiveCommand(configPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("First archived sequence: 1\nLast archived sequence: 3\nNo missing range.");
    const command = Bun.spawn(["bun", resolve(import.meta.dir, "../../../cortex.ts"), "ledger", "archive", "verify", "--config", configPath], {
      stdout: "pipe", stderr: "pipe", env: process.env,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("ledger archive verify:");
    expect(stdout).toContain("No missing range.");
    await archive.stop();
    expect(await readRows()).toStartWith(firstRows);
    expect((await jsm.consumers.list(LEDGER_STREAM).next()).length).toBe(0);
    expect(error).not.toHaveBeenCalled();
    await jsm.streams.deleteMessage(LEDGER_STREAM, 2);
    expect(await createLedgerStream(js, jsm).sequences()).toEqual([1, 3]);
    expect((await verifyArchiveCommand(configPath)).exitCode).toBe(0);
  } finally {
    await archive?.stop();
    await runtime?.stop();
    await nc.close();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
