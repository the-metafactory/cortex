import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withFlowFile<T>(yaml: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "desk-flow-"));
  try {
    const file = join(dir, "flow.yaml");
    await writeFile(file, yaml, { mode: 0o600, flag: "wx" });
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
