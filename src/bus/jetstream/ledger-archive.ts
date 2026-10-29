import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, truncateSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { cortexDataDir } from "../../common/data-path";
import { expandTilde } from "../../common/config/loader";

const archiveRowSchema = z.object({
  sequence: z.number().int().positive(),
  subject: z.string().min(1),
  timestamp: z.iso.datetime(),
  data: z.base64(),
});

export type LedgerArchiveRow = z.infer<typeof archiveRowSchema>;
export type LedgerDelivery = Omit<LedgerArchiveRow, "data"> & { data: Uint8Array; ack(): void };
export interface LedgerMessages extends AsyncIterable<LedgerDelivery> {
  stop(): Promise<void>;
}
export interface LedgerStream {
  sequences(): Promise<number[]>;
  consume(startSequence: number): Promise<LedgerMessages>;
}
export interface LedgerArchiveHandle {
  done: Promise<void>;
  stop(): Promise<void>;
}

export function ledgerArchiveDir(configured?: string): string {
  return configured ? expandTilde(configured) : join(cortexDataDir(), "ledger");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function dayFile(timestamp: string): string {
  return `${timestamp.slice(0, 10)}.jsonl`;
}

function listDayFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
  } catch (error) {
    if (missingDirectory(error)) return [];
    throw error;
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function committedLength(bytes: Buffer): number {
  return bytes.lastIndexOf(10) + 1;
}

export function recoverLedgerArchiveTail(directory: string): void {
  const files = listDayFiles(directory);
  for (const file of files) {
    const path = join(directory, file);
    const bytes = readFileSync(path);
    const completeLength = committedLength(bytes);
    if (completeLength === bytes.length) continue;
    if (file !== files.at(-1)) throw new Error(`Incomplete historical LEDGER archive row in ${file}`);
    process.stderr.write(`ledger archive: recovering ${bytes.length - completeLength} uncommitted bytes in ${file}\n`);
    truncateSync(path, completeLength);
    syncPath(path);
    syncPath(directory);
  }
}

export function readLedgerArchive(directory: string): Set<number> {
  const files = listDayFiles(directory);
  const sequences = new Set<number>();
  for (const file of files) {
    const bytes = readFileSync(join(directory, file));
    const completeLength = committedLength(bytes);
    if (completeLength !== bytes.length && file !== files.at(-1)) throw new Error(`Incomplete historical LEDGER archive row in ${file}`);
    for (const line of bytes.subarray(0, completeLength).toString("utf8").split("\n")) {
      if (line.length === 0) continue;
      const row = archiveRowSchema.parse(JSON.parse(line));
      if (dayFile(row.timestamp) !== file) throw new Error(`LEDGER archive date mismatch at sequence ${row.sequence}`);
      if (sequences.has(row.sequence)) throw new Error(`Duplicate LEDGER archive sequence ${row.sequence}`);
      sequences.add(row.sequence);
    }
  }
  return sequences;
}

export type StreamHoldsRange = (first: number, last: number) => Promise<boolean>;

export class LedgerArchiveWriter {
  readonly lastSequence: number;
  readonly startupSequences: Set<number>;
  private cursor: number;
  private readonly lock: Database;
  private current: { file: string; handle: FileHandle } | undefined;

  constructor(readonly directory: string, private readonly streamHolds: StreamHoldsRange = () => Promise.resolve(true)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = new Database(join(directory, ".writer.sqlite"));
    try {
      this.lock.run("BEGIN EXCLUSIVE");
      recoverLedgerArchiveTail(directory);
      this.startupSequences = readLedgerArchive(directory);
      this.cursor = verifyLedgerArchive(this.startupSequences, []).last ?? 0;
      this.lastSequence = this.cursor;
    } catch (error) {
      this.lock.close();
      throw error;
    }
  }

  async append(delivery: LedgerDelivery): Promise<void> {
    if (delivery.sequence <= this.cursor) return;
    if (this.cursor !== 0 && delivery.sequence !== this.cursor + 1) {
      const first = this.cursor + 1;
      const last = delivery.sequence - 1;
      if (await this.streamHolds(first, last)) {
        throw new Error(`LEDGER sequence gap: expected ${first}, received ${delivery.sequence}`);
      }
      process.stderr.write(`ledger archive: sequences ${first}-${last} are no longer held by the stream; continuing at ${delivery.sequence}\n`);
    }
    const row = archiveRowSchema.parse({ ...delivery, data: Buffer.from(delivery.data).toString("base64") });
    try {
      await this.writeRow(row);
    } catch (error) {
      await this.releaseFile();
      throw error;
    }
    this.cursor = row.sequence;
  }

  private async writeRow(row: LedgerArchiveRow): Promise<void> {
    const file = dayFile(row.timestamp);
    const path = join(this.directory, file);
    if (this.current?.file !== file) {
      await this.releaseFile();
      const created = !existsSync(path);
      this.current = { file, handle: await open(path, "a", 0o600) };
      if (created) await syncDirectory(this.directory);
    }
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await this.current.handle.write(bytes, written, bytes.length - written);
      if (bytesWritten === 0) throw new Error("LEDGER archive write made no progress");
      written += bytesWritten;
    }
    await this.current.handle.sync();
  }

  private async releaseFile(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    await current?.handle.close();
  }

  async close(): Promise<void> {
    this.lock.close();
    await this.releaseFile();
  }
}

export async function startLedgerArchive(opts: {
  directory: string;
  stream: LedgerStream;
  log: { error(message: string): void };
}): Promise<LedgerArchiveHandle> {
  const writer = new LedgerArchiveWriter(opts.directory, async (first, last) =>
    (await opts.stream.sequences()).some((sequence) => sequence >= first && sequence <= last));
  let messages: LedgerMessages;
  try {
    const { first, last, missing } = verifyLedgerArchive(writer.startupSequences, await opts.stream.sequences());
    const retainedGaps = missing.filter((range) => range.retained && first !== null && last !== null && range.first > first && range.last < last);
    for (const range of retainedGaps) {
      opts.log.error(`ledger archive is missing sequences ${range.first}-${range.last} that the stream still holds`);
    }
    messages = await opts.stream.consume(writer.lastSequence + 1);
  } catch (error) {
    await writer.close();
    throw error;
  }
  const done = (async () => {
    try {
      for await (const delivery of messages) {
        await writer.append(delivery);
        delivery.ack();
      }
    } catch (error) {
      opts.log.error(`ledger archive stopped: ${errorMessage(error)}`);
    } finally {
      try {
        await messages.stop();
      } catch (error) {
        opts.log.error(`ledger archive cleanup failed: ${errorMessage(error)}`);
      } finally {
        await writer.close();
      }
    }
  })();
  return { done, stop: async () => { await messages.stop(); await done; } };
}

export function verifyLedgerArchive(archived: Iterable<number>, retained: Iterable<number>) {
  const archive = new Set(archived);
  const sorted = [...archive].sort((a, b) => a - b);
  const first = sorted[0] ?? null;
  const last = sorted.at(-1) ?? null;
  const missing: { first: number; last: number; retained: boolean }[] = [];
  const stream = new Set(retained);
  const add = (first: number, last: number, retained: boolean) => {
    const previous = missing.at(-1);
    if (previous && previous.last + 1 === first && previous.retained === retained) previous.last = last;
    else missing.push({ first, last, retained });
  };
  const expected = [...new Set([...sorted, ...stream])].sort((a, b) => a - b);
  let previous: number | undefined;
  for (const sequence of expected) {
    if (previous !== undefined && sequence > previous + 1) add(previous + 1, sequence - 1, false);
    if (!archive.has(sequence)) add(sequence, sequence, stream.has(sequence));
    previous = sequence;
  }
  return { first, last, missing, ok: !missing.some((range) => range.retained) };
}
