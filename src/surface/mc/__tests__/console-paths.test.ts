import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config";
import { DASHBOARD_DIST, startServer } from "../server";
import type { Config } from "../types";
import { createStaticConsoleRig, statusLine, type StaticConsoleRig } from "./static-console-rig";

const INDEX = "<!doctype html><div id=\"root\"></div><script type=\"module\" src=\"./app.js\"></script>\n";
const APP = "globalThis.bundledApp = true;\n";
const CHUNK = "export default () => import(\"./app.js\");\n";
const EXTERNAL_INDEX = "<!doctype html><title>External UI</title>\n";
const EXTERNAL_APP = "globalThis.externalUi = true;\n";
const ACCESS_HOST = "desk.example.com";

describe("Mission Control console served under /mc/", () => {
  let rig: StaticConsoleRig;
  let dist: string;

  beforeEach(() => {
    rig = createStaticConsoleRig("mc-console-paths-", { index: EXTERNAL_INDEX, script: EXTERNAL_APP });
    dist = join(rig.dir, "dist");
    mkdirSync(dist);
    const files: [string, string][] = [["index.html", INDEX], ["app.js", APP], ["network-canvas-test.js", CHUNK]];
    for (const [name, body] of files) writeFileSync(join(dist, name), body);
  });

  afterEach(() => {
    rig.cleanup();
  });

  function serve(config: Partial<Config> = {}): string {
    return rig.serve(config, { dashboardDist: dist });
  }

  test("redirects / and /mc to /mc/ with the query string", async () => {
    const base = serve();
    const cases: [string, string][] = [
      ["/", "/mc/"],
      ["/mc", "/mc/"],
      ["/?mode=desk", "/mc/?mode=desk"],
      ["/?mode=desk&tab=day", "/mc/?mode=desk&tab=day"],
      ["/mc?mode=desk", "/mc/?mode=desk"],
    ];
    for (const [path, location] of cases) {
      const response = await fetch(base + path, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(location);
    }
  });

  test("serves the bundled shell at /mc/ and /mc/index.html with the headers /index.html sends", async () => {
    const base = serve();
    const bundledShell = await fetch(`${base}/index.html`);
    for (const path of ["/mc/", "/mc/index.html"]) {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe(bundledShell.headers.get("content-security-policy"));
      expect(await response.text()).toBe(INDEX);
    }
    expect(bundledShell.headers.get("content-security-policy")).toContain(`${base}/api/desk/adapters/assets/`);
  });

  test("serves a bundled dashboard asset under /mc/, including a lazily loaded chunk", async () => {
    const base = serve();
    const files: [string, string][] = [["app.js", APP], ["network-canvas-test.js", CHUNK]];
    for (const [name, body] of files) {
      const response = await fetch(`${base}/mc/${name}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    }
  });

  test("a configured external UI keeps / and root assets, and /mc/ stays the bundled console", async () => {
    const base = serve({ ui: { dir: rig.ui } });
    expect(await (await fetch(`${base}/`)).text()).toBe(EXTERNAL_INDEX);
    expect(await (await fetch(`${base}/index.html`)).text()).toBe(EXTERNAL_INDEX);
    expect(await (await fetch(`${base}/app.js`)).text()).toBe(EXTERNAL_APP);
    expect(await (await fetch(`${base}/mc/`)).text()).toBe(INDEX);
    expect(await (await fetch(`${base}/mc/index.html`)).text()).toBe(INDEX);
    expect(await (await fetch(`${base}/mc/app.js`)).text()).toBe(APP);
    expect((await fetch(`${base}/`)).headers.get("content-security-policy")).toBe((await fetch(`${base}/mc/`)).headers.get("content-security-policy"));
  });

  test("404s /mc/ paths outside the asset pattern, with and without an external UI", async () => {
    for (const config of [{}, { ui: { dir: rig.ui } }]) {
      const base = serve(config);
      for (const path of ["/mc/../x", "/mc/%2e%2e/x.js", "/mc//app.js", "/mc/app.txt", "/mc/nested/app.js", "/mc/.hidden", "/mc/..secret.js", "/mc/app.js/extra"]) {
        const response = await fetch(base + path);
        expect(response.status).toBe(404);
      }
      expect(statusLine(await rig.rawResponse(base, "/mc/../x"))).toStartWith("HTTP/1.1 404");
      expect(statusLine(await rig.rawResponse(base, "/mc/missing.js"))).toStartWith("HTTP/1.1 404");
    }
  });

  test("leaves /api/*, /ws and /wake/ at their root paths", async () => {
    const base = serve();
    for (const path of ["/api/desk", "/health"]) {
      expect((await fetch(base + path)).status).toBe(200);
    }
    expect((await fetch(`${base}/wake/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/mc/wake/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/mc/ws`)).status).toBe(404);
  });

  test("applies the Access hostname identity gate to /mc/ exactly as to /", async () => {
    const base = serve({ cfAccess: { aud: "console-aud", teamDomain: "console-team", hostnames: [ACCESS_HOST] } });
    for (const path of ["/", "/mc/", "/mc/app.js"]) {
      expect(statusLine(await rig.rawResponse(base, path, ACCESS_HOST))).toStartWith("HTTP/1.1 401");
    }
    expect(statusLine(await rig.rawResponse(base, "/"))).toStartWith("HTTP/1.1 302");
    expect(statusLine(await rig.rawResponse(base, "/mc/"))).toStartWith("HTTP/1.1 200");
  });

  test.skipIf(!existsSync(join(DASHBOARD_DIST, "index.html")))("the built dashboard references its assets relatively, so /mc/ serves the lazily loaded network-canvas chunk", async () => {
    const html = readFileSync(join(DASHBOARD_DIST, "index.html"), "utf8");
    const references = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]!);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(reference.startsWith("./")).toBe(true);
    const server = startServer({ ...DEFAULT_CONFIG, port: 0 }, rig.db);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      for (const reference of references) {
        const response = await fetch(`${base}/mc/${reference.slice(2)}`);
        expect(response.status).toBe(200);
        expect(await response.arrayBuffer()).toEqual(await Bun.file(join(DASHBOARD_DIST, reference.slice(2))).arrayBuffer());
      }
      const chunk = readdirSync(DASHBOARD_DIST).find(name => /^network-canvas-.*\.js$/.test(name));
      expect(chunk).toBeDefined();
      const response = await fetch(`${base}/mc/${chunk!}`);
      expect(response.status).toBe(200);
      expect(await response.arrayBuffer()).toEqual(await Bun.file(join(DASHBOARD_DIST, chunk!)).arrayBuffer());
    } finally {
      server.stop(true);
    }
  });
});
