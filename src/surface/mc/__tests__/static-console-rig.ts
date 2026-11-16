import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { startServer, type ServerContext, type StartServerOptions } from "../server";
import type { Config } from "../types";

export interface StaticConsoleRig {
  readonly dir: string;
  readonly ui: string;
  readonly db: ReturnType<typeof initDatabase>;
  serve(config?: Partial<Config>, options?: StartServerOptions): string;
  rawResponse(base: string, path: string, host?: string): Promise<string>;
  cleanup(): void;
}

export function statusLine(raw: string): string {
  return raw.split("\r\n")[0] ?? "";
}

export function createStaticConsoleRig(prefix: string, externalUi: { index: string; script: string }): StaticConsoleRig {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const ui = join(dir, "ui");
  mkdirSync(ui);
  writeFileSync(join(ui, "index.html"), externalUi.index);
  writeFileSync(join(ui, "app.js"), externalUi.script);
  const db = initDatabase(join(dir, "mc.db"));
  const servers: ServerContext[] = [];
  return {
    dir,
    ui,
    db,
    serve(config = {}, options = {}) {
      const server = startServer({ ...DEFAULT_CONFIG, port: 0, ...config }, db, options);
      servers.push(server);
      return `http://127.0.0.1:${server.port}`;
    },
    rawResponse(base, path, host) {
      const port = Number(new URL(base).port);
      return new Promise((resolve, reject) => {
        let data = "";
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host ?? `127.0.0.1:${port}`}\r\nConnection: close\r\n\r\n`);
        });
        socket.on("data", chunk => { data += String(chunk); });
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
    },
    cleanup() {
      for (const server of servers) server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
