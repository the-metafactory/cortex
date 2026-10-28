import { Database } from "bun:sqlite";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, truncateSync, writeSync } from "node:fs";
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

function missingDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function readLedgerArchive(directory: string, recoverTail = false): Set<number> {
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
  } catch (error) {
    if (missingDirectory(error)) return new Set();
    throw error;
  }
  const sequences = new Set<number>();
  for (const file of files) {
    const path = join(directory, file);
    const bytes = readFileSync(path);
    const completeLength = bytes.lastIndexOf(10) + 1;
    if (completeLength !== bytes.length) {
      if (!recoverTail) throw new Error(`Incomplete LEDGER archive row in ${file}`);
      if (file !== files.at(-1)) throw new Error(`Incomplete historical LEDGER archive row in ${file}`);
      process.stderr.write(`ledger archive: recovering ${bytes.length - completeLength} uncommitted bytes in ${file}\n`);
      truncateSync(path, completeLength);
    }
    for (const line of bytes.subarray(0, completeLength).toString("utf8").split("\n")) {
      if (line.length === 0) continue;
      const row = archiveRowSchema.parse(JSON.parse(line));
      if (`${row.timestamp.slice(0, 10)}.jsonl` !== file) throw new Error(`LEDGER archive date mismatch at sequence ${row.sequence}`);
      if (sequences.has(row.sequence)) throw new Error(`Duplicate LEDGER archive sequence ${row.sequence}`);
      sequences.add(row.sequence);
    }
    if (recoverTail) syncPath(path);
  }
  if (recoverTail) syncPath(directory);
  return sequences;
}

export class LedgerArchiveWriter {
  readonly lastSequence: number;
  private cursor: number;
  private readonly lock: Database;

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = new Database(join(directory, ".writer.sqlite"));
    try {
      this.lock.run("BEGIN EXCLUSIVE");
      const sequences = readLedgerArchive(directory, true);
      const verification = verifyLedgerArchive(sequences, []);
      if (verification.missing.length > 0) throw new Error("LEDGER archive contains sequence gaps; repair before resuming");
      this.cursor = verification.last ?? 0;
      this.lastSequence = this.cursor;
    } catch (error) {
      this.lock.close();
      throw error;
    }
  }

  append(delivery: LedgerDelivery): void {
    if (delivery.sequence <= this.cursor) return;
    if (this.cursor !== 0 && delivery.sequence !== this.cursor + 1) {
      throw new Error(`LEDGER sequence gap: expected ${this.cursor + 1}, received ${delivery.sequence}`);
    }
    const row = archiveRowSchema.parse({ ...delivery, data: Buffer.from(delivery.data).toString("base64") });
    const path = join(this.directory, `${row.timestamp.slice(0, 10)}.jsonl`);
    const fd = openSync(path, "a", 0o600);
    try {
      const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(fd, bytes, written, bytes.length - written);
        if (count === 0) throw new Error("LEDGER archive write made no progress");
        written += count;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncPath(this.directory);
    this.cursor = row.sequence;
  }

  close(): void {
    this.lock.close();
  }
}

export async function startLedgerArchive(opts: {
  directory: string;
  stream: LedgerStream;
  log: { error(message: string): void };
}): Promise<LedgerArchiveHandle> {
  const writer = new LedgerArchiveWriter(opts.directory);
  let messages: LedgerMessages;
  try {
    messages = await opts.stream.consume(writer.lastSequence + 1);
  } catch (error) {
    writer.close();
    throw error;
  }
  const done = (async () => {
    try {
      for await (const delivery of messages) {
        writer.append(delivery);
        delivery.ack();
      }
    } catch (error) {
      opts.log.error(`ledger archive stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        await messages.stop();
      } catch (error) {
        opts.log.error(`ledger archive cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        writer.close();
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
