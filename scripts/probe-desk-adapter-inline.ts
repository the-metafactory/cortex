#!/usr/bin/env bun
import { chromium, webkit } from "playwright";
import { probeChecks } from "./lib/probe-checks";
import { ASSET_OWNER, INLINE_ENTRY, entryUrl, inlineUiFixture, openAssetRig } from "../src/surface/mc/desk/__tests__/fixtures/adapter-asset-fixtures";

const { check, finish } = probeChecks();
const ui = inlineUiFixture(INLINE_ENTRY.replace('</head>', '<link rel="stylesheet" href="print.css" media="print"></head>'));
ui.files["ui/app.js"] = { body: 'document.documentElement.dataset.script = "ran-é";', mediaType: "text/javascript" };
ui.files["ui/styles/main.css"] = { body: `${ui.files["ui/styles/main.css"]?.body} #styled::after { content: "café"; }`, mediaType: "text/css" };
ui.files["ui/print.css"] = { body: '#styled { color: rgb(255, 0, 0); }', mediaType: "text/css" };
const good = await openAssetRig({ ui });
const bad = await openAssetRig({ ui: inlineUiFixture('<script>throw new Error("must not run")</script>') });
const requests: string[] = [];
const goodEntry = await entryUrl(good);
const badEntry = await entryUrl(bad);
const sessionCookie = "desk-inline-probe=authenticated";
const gateway = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/local" || path === "/hosted") {
      return new Response(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body><iframe sandbox="allow-scripts" src="${path}/good${goodEntry}"></iframe></body></html>`, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...(path === "/hosted" ? { "Set-Cookie": `${sessionCookie}; HttpOnly; SameSite=Lax; Path=/` } : {}) },
      });
    }
    const route = /^\/(local|hosted)\/(good|bad)(\/api\/desk\/adapters\/assets\/.*)$/.exec(path);
    if (!route) return new Response("Not found", { status: 404 });
    const rig = route[2] === "good" ? good : bad;
    const assetPath = route[3] ?? "";
    return route[1] === "local" ? rig.local(assetPath) : rig.hosted(assetPath, { principal: request.headers.get("cookie")?.includes(sessionCookie) ? ASSET_OWNER : null });
  },
});
const origin = `http://127.0.0.1:${gateway.port}`;

try {
  check((await fetch(`${origin}/hosted/good${goodEntry}`)).status === 401, "hosted entry navigation requires authentication");
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch({ headless: true });
    try {
      for (const mode of ["local", "hosted"] as const) {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          const browserRequests: string[] = [];
          const pageErrors: string[] = [];
          page.on("request", request => { if (/^https?:/.test(request.url())) browserRequests.push(request.url()); });
          page.on("pageerror", error => pageErrors.push(error.message));
          requests.length = 0;
          await page.goto(`${origin}/${mode}`, { waitUntil: "networkidle" });
          const frame = page.frames().find(candidate => candidate.url() === `${origin}/${mode}/good${goodEntry}`);
          if (!frame) throw new Error(`${browserType.name()} ${mode}: entry frame did not navigate`);
          const state = await frame.evaluate(() => {
            const image = document.querySelector<HTMLImageElement>("#picture");
            const styled = document.querySelector("#styled");
            let parentDenied = false;
            try { void parent.document; } catch (error) { parentDenied = error instanceof DOMException && error.name === "SecurityError"; }
            return {
              script: document.documentElement.dataset.script,
              color: styled ? getComputedStyle(styled).color : "",
              content: styled ? getComputedStyle(styled, "::after").content : "",
              background: styled ? getComputedStyle(styled).backgroundImage : "",
              image: image?.complete && image.naturalWidth === 3 && image.naturalHeight === 2,
              parentDenied,
              resources: performance.getEntriesByType("resource").map(entry => entry.name).filter(name => /^https?:/.test(name)),
            };
          });
          const label = `${browserType.name()} ${mode}`;
          check(state.script === "ran-é", `${label}: hash-pinned UTF-8 classic script runs without meta charset`);
          check(state.color === "rgb(12, 34, 56)" && state.content === '"café"' && state.background.includes("data:image/svg+xml;base64,"), `${label}: hash-pinned UTF-8 stylesheet and CSS image apply while print styles stay inactive`);
          check(state.image === true, `${label}: manifest image loads from a data URI`);
          check(state.parentDenied, `${label}: sandbox retains its opaque origin`);
          check(pageErrors.length === 0, `${label}: script has no runtime errors`);
          check(JSON.stringify(browserRequests) === JSON.stringify([`${origin}/${mode}`, `${origin}/${mode}/good${goodEntry}`]) && state.resources.length === 0, `${label}: browser issues zero network requests after entry navigation`);
          check(JSON.stringify(requests) === JSON.stringify([`/${mode}`, `/${mode}/good${goodEntry}`]), `${label}: server receives only wrapper and entry navigations`);
          const rejected = await context.request.get(`${origin}/${mode}/bad${badEntry}`);
          check(rejected.status() === 422 && (await rejected.json() as { code: string }).code === "ui_not_inlinable", `${label}: unsupported entry returns 422`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await gateway.stop(true);
  await bad.close();
  await good.close();
}

finish("Desk adapter inline probe failed.", "Desk adapter inline probe passed in Chromium and WebKit on local and authenticated hosted rig routes. No provider, credential or deployment used.");
