import type { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer } from "../../server";
import type { ServerContext, StartServerOptions } from "../../server";
import { initDatabase } from "../../db/init";
import { DEFAULT_CONFIG } from "../../config";
import { ProcessManager } from "../../session/process-manager";

export interface McTestServer {
  db: Database;
  ctx: ServerContext;
  pm: ProcessManager;
  port: number;
  baseUrl: string;
  tmpDir: string;
}

export function startMcTestServer(
  tmpDirPrefix: string,
  options: Omit<StartServerOptions, "processManager">
): McTestServer {
  const tmpDir = join(tmpdir(), `${tmpDirPrefix}-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const pm = new ProcessManager();
  const ctx = startServer({ ...DEFAULT_CONFIG, port: 0 }, db, {
    ...options,
    processManager: pm,
  });
  const port = ctx.port;
  return { db, ctx, pm, port, baseUrl: `http://localhost:${port}`, tmpDir };
}

export async function stopMcTestServer(t: McTestServer): Promise<void> {
  await t.pm.closeAll();
  t.ctx.stop(true);
  t.db.close();
  rmSync(t.tmpDir, { recursive: true, force: true });
}
