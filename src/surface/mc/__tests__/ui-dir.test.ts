import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { connect } from "node:net";
import { stringify } from "yaml";
import { loadConfigWithAgents } from "../../../common/config/loader";
import { dispatchConfig } from "../../../cli/cortex/commands/config";
import { DEFAULT_CONFIG, loadConfig } from "../config";
import { initDatabase } from "../db/init";
import { startMissionControl } from "../embed";
import { DASHBOARD_DIST, startServer, type ServerContext } from "../server";
import type { Config } from "../types";

describe("Mission Control mc.ui.dir", () => {
  let dir: string;
  let ui: string;
  let db: ReturnType<typeof initDatabase>;
  let servers: ServerContext[];
  const html = "<!doctype html><title>External UI</title>\n";
  const script = "globalThis.externalUi = true;\n";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-ui-dir-"));
    ui = join(dir, "ui");
    mkdirSync(ui);
    writeFileSync(join(ui, "index.html"), html);
    writeFileSync(join(ui, "app.js"), script);
    db = initDatabase(join(dir, "mc.db"));
    servers = [];
  });

  afterEach(() => {
    for (const server of servers) server.stop(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function serve(config: Partial<Config> = {}): string {
    const server = startServer({ ...DEFAULT_CONFIG, port: 0, ...config }, db);
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  function stackConfig(uiDir: string): string {
    const path = join(dir, "stack.yaml");
    writeFileSync(path, stringify({
      principal: { id: "example" },
      stack: { id: "example/test" },
      agents: [{ id: "assistant", displayName: "Assistant", persona: "./assistant.md", presence: {} }],
      claude: {},
      mc: { enabled: true, ui: { dir: uiDir } },
    }), { mode: 0o600 });
    return path;
  }

  test.skipIf(!existsSync(join(DASHBOARD_DIST, "index.html")))("preserves the bundled Desk shell and asset bytes without mc.ui.dir", async () => {
    const base = serve();
    for (const path of ["/", "/index.html"]) {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(await response.arrayBuffer()).toEqual(await Bun.file(join(DASHBOARD_DIST, "index.html")).arrayBuffer());
    }
    const asset = readdirSync(DASHBOARD_DIST).find(name => /^[\w.-]+\.js$/.test(name));
    expect(asset).toBeDefined();
    const response = await fetch(`${base}/${asset!}`);
    expect(response.status).toBe(200);
    expect(await response.arrayBuffer()).toEqual(await Bun.file(join(DASHBOARD_DIST, asset!)).arrayBuffer());
  });

  test("serves configured files and gives both shell paths the Desk CSP", async () => {
    const bundled = serve();
    const base = serve({ ui: { dir: ui } });
    const expectedCsp = (await fetch(`${bundled}/index.html`)).headers.get("content-security-policy")?.replaceAll(bundled, base);
    for (const path of ["/", "/index.html"]) {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(html);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe(expectedCsp!);
    }
    const response = await fetch(`${base}/app.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(script);
    expect(response.headers.get("content-type")).toContain("javascript");
  });

  test("preserves Cortex routes and the API Host and Origin checks", async () => {
    mkdirSync(join(ui, "wake"));
    writeFileSync(join(ui, "wake/worker.js"), "external wake must not be served");
    const bundled = serve();
    const base = serve({ ui: { dir: ui } });
    for (const path of ["/api/desk", "/health", "/wake/worker.js", "/ws"]) {
      const expected = await fetch(bundled + path);
      const actual = await fetch(base + path);
      expect(actual.status).toBe(expected.status);
      expect(await actual.text()).toBe(await expected.text());
    }
    expect(await (await fetch(`${base}/api/desk`)).json()).toEqual({ enabled: false });
    for (const headers of [new Headers({ Host: "attacker.invalid" }), new Headers({ Origin: "https://attacker.invalid" })]) {
      expect((await fetch(`${base}/api/desk`, { method: "POST", headers })).status).toBe(403);
    }
  });

  test("returns 404 for outside symlinks, missing files and paths outside the static allowlist", async () => {
    const outside = `${ui}-outside`;
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.js"), "private");
    symlinkSync(join(outside, "secret.js"), join(ui, "leak.js"));
    symlinkSync(join(ui, "app.js"), join(ui, "inside.js"));
    mkdirSync(join(ui, "directory.js"));
    writeFileSync(join(ui, "private.txt"), "not an allowed asset");
    mkdirSync(join(ui, "nested"));
    writeFileSync(join(ui, "nested/app.js"), script);
    const base = serve({ ui: { dir: ui } });
    for (const path of ["/leak.js", "/missing.js", "/directory.js", "/private.txt", "/nested/app.js", "/%2e%2e%2fsecret.js", "/..secret.js"]) {
      expect((await fetch(base + path)).status).toBe(404);
    }
    expect(await (await fetch(`${base}/inside.js`)).text()).toBe(script);
    expect((await fetch(`${base}/app.js`, { method: "POST" })).status).toBe(404);
    rmSync(join(ui, "index.html"));
    symlinkSync(join(outside, "secret.js"), join(ui, "index.html"));
    expect((await fetch(base)).status).toBe(404);
  });

  test("a raw HTTP parent path cannot read a file beside the UI directory", async () => {
    writeFileSync(join(dir, "secret.js"), "private");
    const base = serve({ ui: { dir: ui } });
    const response = await new Promise<string>((resolve, reject) => {
      let data = "";
      const socket = connect(Number(new URL(base).port), "127.0.0.1", () => {
        socket.write(`GET /../secret.js HTTP/1.1\r\nHost: ${new URL(base).host}\r\nConnection: close\r\n\r\n`);
      });
      socket.on("data", chunk => { data += String(chunk); });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(response).toStartWith("HTTP/1.1 404");
    expect(response).not.toContain("private");
  });

  test("loads the stack key and passes it through the embedded Mission Control server", async () => {
    const loaded = loadConfigWithAgents(stackConfig(ui));
    expect(loaded.config.mc.ui).toEqual({ dir: ui });
    const mcPath = join(dir, "mc.yaml");
    writeFileSync(mcPath, stringify({ port: 0, hooks: { rawEventsDir: join(dir, "events") } }));
    const handle = await startMissionControl({ configPath: mcPath, dbPath: join(dir, "embedded.db"), ui: loaded.config.mc.ui });
    try {
      expect(await (await fetch(`http://127.0.0.1:${handle.port}/`)).text()).toBe(html);
    } finally {
      await handle.stop();
    }
    writeFileSync(mcPath, stringify({ ui: { dir: ui } }));
    expect(loadConfig(mcPath).ui).toEqual({ dir: ui });
  });

  test("expands ~/ and accepts a directory symlink as the configured root", async () => {
    const homeUi = mkdtempSync(join(homedir(), "mc-ui-dir-"));
    try {
      writeFileSync(join(homeUi, "index.html"), html);
      const base = serve({ ui: { dir: `~/${basename(homeUi)}` } });
      expect(await (await fetch(base)).text()).toBe(html);
      expect((await dispatchConfig(["validate", "--config", stackConfig(`~/${basename(homeUi)}`)])).exitCode).toBe(0);
      symlinkSync(homeUi, join(dir, "linked-ui"));
      expect(await (await fetch(serve({ ui: { dir: join(dir, "linked-ui") } }))).text()).toBe(html);
    } finally {
      rmSync(homeUi, { recursive: true, force: true });
    }
  });

  test.each(["missing", "no-index", "not-directory", "index-directory", "relative"])("rejects %s in config validate and server startup with the same message", async kind => {
    const bad = kind === "relative" ? "relative/ui" : join(dir, kind);
    if (kind === "no-index" || kind === "index-directory") mkdirSync(bad);
    if (kind === "index-directory") mkdirSync(join(bad, "index.html"));
    if (kind === "not-directory") writeFileSync(bad, html);
    const message = kind === "relative"
      ? "mc.ui.dir must be an absolute path or start with ~/"
      : "mc.ui.dir must name an existing directory containing index.html";
    const validated = await dispatchConfig(["validate", "--config", stackConfig(bad)]);
    expect(validated.exitCode).toBe(1);
    expect(validated.stderr).toContain(message);
    expect(() => serve({ ui: { dir: bad } })).toThrow(message);
    const mcPath = join(dir, "mc.yaml");
    writeFileSync(mcPath, stringify({ ui: { dir: bad } }));
    expect(() => loadConfig(mcPath)).toThrow(message);
  });

  test("revalidates the directory at startup after a successful config validation", async () => {
    const path = stackConfig(ui);
    expect((await dispatchConfig(["validate", "--config", path])).exitCode).toBe(0);
    const loaded = loadConfigWithAgents(path);
    rmSync(join(ui, "index.html"));
    expect(() => serve({ ui: loaded.config.mc.ui })).toThrow("mc.ui.dir must name an existing directory containing index.html");
  });
});
