import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { FRAME_ATTACKS } from "../src/surface/mc/desk/__tests__/fixtures/adapter-frame-ui";
import { serveFrameProbe } from "./desk-adapter-frame/server";

const evidence: unknown[] = [];
const received: string[] = [];
const attacker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { received.push(req.url); return new Response("attacker"); } });
let failures = 0;
try {
  for (const type of [chromium, webkit, firefox]) {
    let browser;
    try { browser = await type.launch({ headless: true, timeout: 10_000 }); }
    catch (error) {
      const unavailable = { browser: type.name(), status: "not-run", reason: error instanceof Error ? error.message : String(error) };
      evidence.push(unavailable);
      console.error(`${type.name()}: NOT RUN (browser launch failed)`);
      if (type !== firefox) failures++;
      continue;
    }
    try {
      for (const mode of ["local", "hosted"] as const) for (const attack of FRAME_ATTACKS) {
        const fixture = await serveFrameProbe(attack, mode, attacker.url.origin);
        const context = await browser.newContext();
        const row: Record<string, unknown> = { browser: type.name(), version: browser.version(), mode, attack, status: "failed" };
        const finish = Promise.withResolvers<undefined>();
        try {
          const deriving = Promise.withResolvers<undefined>();
          if (attack === "late-revoke") fixture.rig.state.projection = async () => {
            deriving.resolve(undefined);
            await finish.promise;
            return { projectionId: "late", revision: 1, object: { title: "SYNTHETIC-LATE-PRIVATE-CANARY" } };
          };
          const page = await context.newPage();
          const ran: string[] = [];
          const requests: string[] = [];
          const popups: string[] = [];
          const downloads: string[] = [];
          page.on("console", message => { if (message.text().startsWith("FRAME_PROBE:")) ran.push(message.text()); });
          page.on("request", request => { requests.push(request.url()); });
          page.on("popup", popup => { popups.push(popup.url()); });
          page.on("download", download => { downloads.push(download.suggestedFilename()); });
          const start = received.length;
          if (mode === "hosted") assert.equal((await fetch(new URL("/api/desk/adapters/catalog", fixture.server.url))).status, 401);
          fixture.requests.length = 0;
          await page.goto(fixture.server.url.href);
          if (attack === "late-revoke") {
            const signal = AbortSignal.timeout(8000);
            await Promise.race([deriving.promise, new Promise((_, reject) => signal.addEventListener("abort", () => { reject(signal.reason); }, { once: true }))]);
            fixture.rig.authority.policy.releaseAllowed = false;
            finish.resolve(undefined);
          }
          const unavailable = ["late-revoke", "mismatch", "throw", "forged", "replay", "wrong-release", "wrong-generation", "wrong-connection", "unknown-field", "before-ready", "cross-connection", "navigate", "before-load", "remote", "data", "blob", "redirect", "download"].includes(attack);
          await page.locator(`[data-adapter-state="${unavailable ? "unavailable" : "ready"}"]`).waitFor({ timeout: 8000 });
          await page.waitForTimeout(150);
          assert.ok(ran.some(value => value === `FRAME_PROBE:${attack}`), "attack script actually ran");
          if (attack === "fetch") assert.ok(ran.includes("FRAME_PROBE:fetch-denied") && !ran.includes("FRAME_PROBE:fetch-allowed"), "direct fetch denied");
          if (attack === "worker" || attack === "service-worker") assert.ok(ran.includes(`FRAME_PROBE:${attack}-denied`) && !ran.includes(`FRAME_PROBE:${attack}-allowed`), "worker execution denied");
          assert.equal(received.length, start, "zero attacker HTTP requests");
          assert.equal(popups.length, 0);
          assert.equal(downloads.length, 0);
          assert.equal(await page.locator("body").getAttribute("data-compromised"), null);
          assert.equal(fixture.rig.authority.calls.dispatch + fixture.rig.authority.calls.cancel, 0, "zero owner mutations");
          const entry = fixture.rig.opened.entry;
          const entryPath = entry.files.find(file => file.path === entry.entry)!.url;
          const allowed = new Set(["GET /", "GET /index.html", "GET /probe.js", "GET /probe.css", "GET /fixture.json", "GET /styles/tokens.css", "GET /styles/global.css", "GET /styles/constellation.css", "POST /api/desk/adapters/frames", `GET ${entryPath}`]);
          for (const request of fixture.requests) assert.ok(allowed.has(request) || /^(GET|POST|DELETE) \/api\/desk\/adapters\/frames\/[a-f0-9]{32}$/.test(request) || attack.startsWith("editor-") && /^GET \/api\/desk\/drafts(?:\/[^/]+)?$/.test(request), `unexpected host network request: ${request}`);
          assert.ok(!fixture.requests.some(request => request.endsWith("/confirm")), "package never calls host confirmation");
          if (attack === "editor-propose") {
            const review = page.getByRole("heading", { name: "Review proposed action" });
            await review.waitFor();
            const entered = Promise.withResolvers<undefined>();
            const finish = Promise.withResolvers<undefined>();
            const draftId = fixture.rig.binding.editor!.draftId;
            await page.route(`**/api/desk/drafts/${draftId}`, async route => { entered.resolve(undefined); await finish.promise; await route.continue(); }, { times: 1 });
            await page.getByRole("button", { name: "Reopen draft", exact: true }).click();
            await entered.promise;
            fixture.rig.authority.policy.releaseAllowed = false;
            await page.locator('[data-adapter-state="unavailable"]').waitFor();
            finish.resolve(undefined);
            await page.waitForTimeout(200);
            assert.equal(await review.count(), 0, "late host review response cannot restore revoked review");
          }
          if (attack === "editor-change") {
            await page.waitForFunction(() => Array.from(document.querySelectorAll("iframe")).some(wrapper => {
              try { return wrapper.contentDocument?.querySelector("iframe") !== null; } catch { return false; }
            }));
            const draft = fixture.rig.binding.editor!;
            await page.waitForTimeout(150);
            assert.equal((await draft.service.read(draft.draftId))?.draft.fields["/title"]?.value, "Browser principal edit");
          }
          if (unavailable) {
            await page.getByText("Safe host history remains available.").waitFor();
            assert.equal(await page.locator('iframe[title="Desk view host"]').count(), 0);
          }
          if (["late-revoke", "before-load", "mismatch", "throw", "before-ready"].includes(attack)) assert.equal(fixture.rig.releases.length, 0);
          if (attack === "good") {
            const child = page.frames().find(frame => frame.url().includes("/api/desk/adapters/assets/"));
            assert.ok(child);
            const denied = await child.evaluate(() => {
              const failures: string[] = [];
              for (const read of [() => parent.document, () => top!.document, () => localStorage.getItem("probe"), () => sessionStorage.getItem("probe")]) {
                try { read(); } catch (error) { failures.push(error instanceof Error ? error.name : "denied"); }
              }
              return failures.length;
            });
            assert.equal(denied, 4, "opaque package cannot access either ancestor or storage");
            fixture.rig.authority.policy.releaseAllowed = false;
            await page.locator('[data-adapter-state="unavailable"]').waitFor();
            await page.getByText("Safe host history remains available.").waitFor();
          }
          Object.assign(row, { status: "passed", ran, requests, serverRequests: fixture.requests, releases: fixture.rig.releases.length, ownerMutations: 0 });
        } catch (error) { failures++; row.error = error instanceof Error ? error.message : String(error); }
        finally { finish.resolve(undefined); evidence.push(row); console.log(JSON.stringify(row)); await context.close(); await fixture.close(); }
      }
    } finally { await browser.close(); }
  }
} finally { await attacker.stop(true); }
const report = { evidence, failures, knownResiduals: ["WebRTC STUN/UDP in Chromium and WebKit (accepted by principal; not asserted blocked)", "WebKit preconnect TCP (accepted by principal; not asserted blocked)"], scope: "Synthetic local and authenticated hosted routes; no provider, external credential or deployment" };
const output = process.env.DESK_FRAME_PROBE_OUTPUT ?? "/tmp/desk-adapter-frame-evidence.json";
await Bun.write(output, JSON.stringify(report, null, 2));
console.log(`Desk adapter frame evidence: ${output}; failures: ${failures}`);
process.exitCode = failures ? 1 : 0;
