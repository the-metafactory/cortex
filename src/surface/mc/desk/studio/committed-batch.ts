import { STUDIO_MAX_FILE_BYTES } from "./read";

export interface CommittedObject { oid: string; size: number }
export const COMMITTED_BATCH_FILES = 64;
export const COMMITTED_BATCH_BYTES = STUDIO_MAX_FILE_BYTES * 4;

async function boundedOutput(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, bytes);
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error("Studio committed batch exceeds its output limit");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
}

export function decodeCommittedBatch(bytes: Buffer, objects: readonly CommittedObject[]): Buffer[] {
  let offset = 0;
  const bodies: Buffer[] = [];
  for (const object of objects) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) throw new Error("Studio committed batch header is incomplete");
    const header = bytes.subarray(offset, newline);
    if (!header.equals(Buffer.from(`${object.oid} blob ${object.size}`, "ascii"))) throw new Error("Studio committed batch object does not match its snapshot");
    const start = newline + 1;
    const end = start + object.size;
    if (end >= bytes.length || bytes[end] !== 10) throw new Error("Studio committed batch body is incomplete");
    bodies.push(bytes.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== bytes.length) throw new Error("Studio committed batch has unexpected trailing data");
  return bodies;
}

export async function readCommittedBatch(dir: string, objects: readonly CommittedObject[]): Promise<Buffer[]> {
  const size = objects.reduce((total, object) => total + object.size, 0);
  if (!objects.length || objects.length > COMMITTED_BATCH_FILES || size > COMMITTED_BATCH_BYTES || objects.some(object => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object.oid) || !Number.isSafeInteger(object.size) || object.size < 0 || object.size > STUDIO_MAX_FILE_BYTES)) throw new Error("Studio committed batch exceeds its input limits");
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const proc = Bun.spawn(["git", "-C", dir, "cat-file", "--batch"], { env, stdin: new Blob([objects.map(object => object.oid).join("\n") + "\n"]), stdout: "pipe", stderr: "pipe", timeout: 15000 });
  try {
    const [stdout, , code] = await Promise.all([boundedOutput(proc.stdout, size + objects.length * 128), boundedOutput(proc.stderr, 65536), proc.exited]);
    if (code !== 0) throw new Error("Studio committed batch lookup failed; overseer deferred");
    return decodeCommittedBatch(stdout, objects);
  } finally { proc.kill(); await proc.exited; }
}
