import { afterEach, describe, expect, mock, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LedgerArchiveWriter, ledgerArchiveDir, readLedgerArchive, startLedgerArchive, verifyLedgerArchive, type LedgerDelivery, type LedgerMessages } from "../ledger-archive";
import { cortexDataDir } from "../../../common/data-path";

const roots: string[] = [];
function temporaryArchive() {
  const root = mkdtempSync(join(tmpdir(), "ledger-archive-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function delivery(sequence: number, timestamp = "2026-01-01T23:59:59.000Z"): LedgerDelivery {
  return { sequence, timestamp, subject: "local.example.default.execution.run.finished", data: new TextEncoder().encode(`{ "id": "${sequence}" }`), ack: mock(() => {}) };
}

function finiteStream(deliveries: LedgerDelivery[], retained = deliveries.map((item) => item.sequence)) {
  const stop = mock(async () => {});
  const consume = mock(async (_start: number): Promise<LedgerMessages> => ({
    async *[Symbol.asyncIterator]() { yield* deliveries; }, stop,
  }));
  return { consume, sequences: async () => retained, stop };
}

describe("LEDGER archive", () => {
  test("appends once by stream sequence, splits UTC days and resumes after an unacknowledged append", async () => {
    const directory = temporaryArchive();
    const first = delivery(1);
    const second = delivery(2, "2026-01-02T00:00:00.000Z");
    const writer = new LedgerArchiveWriter(directory);
    await writer.append(first);
    await writer.close();
    const stream = finiteStream([first, second, second]);
    const archive = await startLedgerArchive({ directory, stream, log: { error: mock(() => {}) } });
    await archive.done;
    expect(stream.consume).toHaveBeenCalledWith(2);
    expect(readLedgerArchive(directory)).toEqual(new Set([1, 2]));
    expect(readdirSync(directory).filter((file) => file.endsWith("jsonl")).sort()).toEqual(["2026-01-01.jsonl", "2026-01-02.jsonl"]);
    const row = JSON.parse(readFileSync(join(directory, "2026-01-02.jsonl"), "utf8"));
    expect(Buffer.from(row.data, "base64")).toEqual(Buffer.from(second.data));
    expect(row.subject).toBe(second.subject);
    expect(row.sequence).toBe(2);
    expect(second.ack).toHaveBeenCalledTimes(2);
  });

  test("a write failure stops acknowledgement and does not consume the following sequence", async () => {
    const directory = temporaryArchive();
    const first = delivery(1);
    const second = delivery(2);
    mkdirSync(join(directory, "2026-01-01.jsonl"));
    const stream = finiteStream([first, second]);
    const error = mock((_message: string) => {});
    await expect(startLedgerArchive({ directory, stream, log: { error } })).rejects.toThrow();
    rmSync(join(directory, "2026-01-01.jsonl"), { recursive: true });
    const failingStream = {
      ...stream,
      consume: async (start: number) => {
        const messages = await stream.consume(start);
        mkdirSync(join(directory, "2026-01-01.jsonl"));
        return messages;
      },
    };
    const archive = await startLedgerArchive({ directory, stream: failingStream, log: { error } });
    await archive.done;
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain("ledger archive stopped");
    expect(stream.stop).toHaveBeenCalledTimes(1);
    rmSync(join(directory, "2026-01-01.jsonl"), { recursive: true });
    const retry = await startLedgerArchive({ directory, stream, log: { error } });
    await retry.done;
    expect(readLedgerArchive(directory)).toEqual(new Set([1, 2]));
  });

  test("acknowledges only after the complete row is readable and handles acknowledgement failure on restart", async () => {
    const directory = temporaryArchive();
    const first = delivery(1);
    first.ack = () => {
      expect(readLedgerArchive(directory)).toEqual(new Set([1]));
      throw new Error("connection lost before ack");
    };
    const second = delivery(2);
    const error = mock((_message: string) => {});
    const interrupted = await startLedgerArchive({ directory, stream: finiteStream([first, second]), log: { error } });
    await interrupted.done;
    expect(second.ack).not.toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toContain("connection lost before ack");
    const stream = finiteStream([delivery(1), second]);
    const resumed = await startLedgerArchive({ directory, stream, log: { error } });
    await resumed.done;
    expect(stream.consume).toHaveBeenCalledWith(2);
    expect(readLedgerArchive(directory)).toEqual(new Set([1, 2]));
  });

  test("an out-of-order delivery stops without acknowledging it or later deliveries", async () => {
    const directory = temporaryArchive();
    const items = [delivery(1), delivery(3), delivery(4)];
    const error = mock((_message: string) => {});
    const archive = await startLedgerArchive({ directory, stream: finiteStream(items, [1, 2, 3, 4]), log: { error } });
    await archive.done;
    expect(items[0]?.ack).toHaveBeenCalledTimes(1);
    expect(items[1]?.ack).not.toHaveBeenCalled();
    expect(items[2]?.ack).not.toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toContain("expected 2, received 3");
    expect(readLedgerArchive(directory)).toEqual(new Set([1]));
  });

  test("resumes past a sequence the stream no longer holds", async () => {
    const directory = temporaryArchive();
    const writer = new LedgerArchiveWriter(directory);
    await writer.append(delivery(1));
    await writer.close();
    const items = [delivery(3), delivery(4)];
    const error = mock((_message: string) => {});
    const archive = await startLedgerArchive({ directory, stream: finiteStream(items, [3, 4]), log: { error } });
    await archive.done;
    expect(error).not.toHaveBeenCalled();
    expect(items[0]?.ack).toHaveBeenCalledTimes(1);
    expect(readLedgerArchive(directory)).toEqual(new Set([1, 3, 4]));
    expect(verifyLedgerArchive(readLedgerArchive(directory), [3, 4]).ok).toBe(true);
    const restarted = await startLedgerArchive({ directory, stream: finiteStream([delivery(5)], [3, 4, 5]), log: { error } });
    await restarted.done;
    expect(readLedgerArchive(directory)).toEqual(new Set([1, 3, 4, 5]));
    expect(error).not.toHaveBeenCalled();
  });

  test("repairs only an interrupted tail, then replays its sequence exactly once", async () => {
    const directory = temporaryArchive();
    const writer = new LedgerArchiveWriter(directory);
    await writer.append(delivery(1));
    await writer.close();
    const file = join(directory, "2026-01-01.jsonl");
    const committed = readFileSync(file, "utf8");
    appendFileSync(file, '{"sequence":2,"subject":');
    const partial = readFileSync(file, "utf8");
    expect(readLedgerArchive(directory)).toEqual(new Set([1]));
    expect(readFileSync(file, "utf8")).toBe(partial);
    appendFileSync(join(directory, "2026-01-02.jsonl"), "{}\n");
    expect(() => readLedgerArchive(directory)).toThrow("Incomplete historical");
    rmSync(join(directory, "2026-01-02.jsonl"));
    const archive = await startLedgerArchive({ directory, stream: finiteStream([delivery(2)]), log: { error: mock(() => {}) } });
    await archive.done;
    expect(readFileSync(file, "utf8").startsWith(committed)).toBe(true);
    expect(readLedgerArchive(directory)).toEqual(new Set([1, 2]));
  });

  test("refuses a second writer, corrupt complete rows and duplicate rows, and reports retained internal gaps", async () => {
    const directory = temporaryArchive();
    const writer = new LedgerArchiveWriter(directory);
    expect(() => new LedgerArchiveWriter(directory)).toThrow();
    await writer.append(delivery(1));
    await writer.close();
    const file = join(directory, "2026-01-01.jsonl");
    const row = readFileSync(file, "utf8");
    appendFileSync(file, row);
    expect(() => new LedgerArchiveWriter(directory)).toThrow("Duplicate");
    writeFileSync(file, `${row}{invalid}\n`);
    expect(() => new LedgerArchiveWriter(directory)).toThrow();
    writeFileSync(file, row + row.replace('"sequence":1', '"sequence":3'));
    const error = mock((_message: string) => {});
    const archive = await startLedgerArchive({ directory, stream: finiteStream([], [1, 2, 3]), log: { error } });
    await archive.done;
    expect(error).toHaveBeenCalledWith("ledger archive is missing sequences 2-2 that the stream still holds");
  });

  test("starts at retained history when older records have already expired", async () => {
    const directory = temporaryArchive();
    const archive = await startLedgerArchive({ directory, stream: finiteStream([delivery(500), delivery(501)]), log: { error: mock(() => {}) } });
    await archive.done;
    expect(readLedgerArchive(directory)).toEqual(new Set([500, 501]));
  });

  test("resolves an override and the cortex data default", () => {
    expect(ledgerArchiveDir()).toBe(join(cortexDataDir(), "ledger"));
    expect(ledgerArchiveDir("/scratch/archive")).toBe("/scratch/archive");
  });
});

describe("archive verification", () => {
  test("reports archive bounds, all missing ranges, and which are still retained", () => {
    expect(verifyLedgerArchive([1, 2, 5, 9], [5, 6, 7, 9, 10])).toEqual({
      first: 1, last: 9, ok: false,
      missing: [
        { first: 3, last: 4, retained: false },
        { first: 6, last: 7, retained: true },
        { first: 8, last: 8, retained: false },
        { first: 10, last: 10, retained: true },
      ],
    });
  });
  test("accepts archived history older than the stream, distinguishes empty archive and expired gaps", () => {
    expect(verifyLedgerArchive([1, 2, 3], [2, 3])).toEqual({ first: 1, last: 3, ok: true, missing: [] });
    expect(verifyLedgerArchive([], [100, 101])).toEqual({ first: null, last: null, ok: false, missing: [{ first: 100, last: 101, retained: true }] });
    expect(verifyLedgerArchive([1, 5], [5]).ok).toBe(true);
    expect(verifyLedgerArchive([], [])).toEqual({ first: null, last: null, ok: true, missing: [] });
  });
});
