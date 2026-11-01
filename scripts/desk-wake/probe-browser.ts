import { chromium } from "playwright";
import { join } from "node:path";
import { wakeAssetResponse } from "../../src/surface/mc/desk/wake-assets";
import { handleDeskTranscribe } from "../../src/surface/mc/api/desk-voice";
import { HandledLedger } from "../../src/surface/mc/desk/actions";

const root = join(import.meta.dir, "../..");
const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "browser-probe.ts")], target: "browser" });
if (!bundle.success || !bundle.outputs[0]) throw new Error("Browser probe failed to build");
const ownershipBundle = await Bun.build({ entrypoints: [join(import.meta.dir, "ownership-probe.ts")], target: "browser" });
if (!ownershipBundle.success || !ownershipBundle.outputs[0]) throw new Error("Ownership probe failed to build");
let adapterCalls = 0;
let receivedBytes = 0;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/wake/")) return wakeAssetResponse(path, join(root, "dist/dashboard-v2"), new URL(req.url).searchParams.get("sha256"));
    if (path === "/probe.js") return new Response(bundle.outputs[0]);
    if (path === "/ownership.js") return new Response(ownershipBundle.outputs[0]);
    if (path === "/ownership") return new Response('<!doctype html><html><body><button id="enable">Enable</button><button id="disable">Disable</button><script src="/ownership.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    if (["/fixtures/public-speech.wav", "/fixtures/hey-ivy.wav", "/fixtures/non-wake.wav"].includes(path)) return new Response(Bun.file(join(import.meta.dir, path.slice(1))));
    if (path === "/api/desk/voice/transcribe") return handleDeskTranscribe(req, {
      options: { enabled: true, displayName: "", rangerUrl: "", topN: 5, areas: [], sources: [], voice: { enabled: true, input: "elevenlabs", output: "browser", elevenlabs: { voiceId: "testvoice1", apiKeyEnv: "TEST_UNUSED_KEY", ttsModel: "test", sttModel: "test", timeoutSeconds: 5 } } }, ledger: new HandledLedger(),
    }, {
      readKey: () => Promise.resolve("test-provider-key"),
      fetchImpl: async (_url, init) => {
        if (!(init.body instanceof FormData)) throw new Error("Transcription did not use existing adapter FormData");
        const file = init.body.get("file");
        if (!(file instanceof Blob)) throw new Error("No actual browser recording reached the adapter");
        receivedBytes = file.size; adapterCalls++;
        return Response.json({ text: "Hey Ivy what needs me" });
      },
    });
    return new Response(`<!doctype html><html><body>${path === "/blank" ? "" : '<script src="/probe.js"></script>'}</body></html>`, { headers: { "content-type": "text/html" } });
  },
});
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", error => process.stderr.write(`${error.message}\n`));
  await page.goto(server.url.toString());
  await page.waitForFunction(() => document.body.dataset.result !== undefined, undefined, { timeout: 180000 });
  const result: unknown = JSON.parse(await page.locator("body").getAttribute("data-result") ?? "null");
  process.stdout.write(JSON.stringify({ result, states: await page.locator("body").getAttribute("data-state"), adapterCalls, receivedBytes }, null, 2) + "\n");
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || adapterCalls !== 1 || !receivedBytes) throw new Error("Browser capture probe failed");
  const owner = await context.newPage();
  const competitor = await context.newPage();
  await owner.goto(new URL("/ownership", server.url).toString());
  await competitor.goto(new URL("/ownership", server.url).toString());
  await owner.locator("#enable").click();
  await owner.waitForFunction(() => document.body.dataset.phase === "listening");
  await competitor.locator("#enable").click();
  await competitor.waitForFunction(() => document.body.dataset.phase === "unavailable");
  if (await competitor.locator("body").getAttribute("data-microphones") !== "0" || !(await competitor.locator("body").getAttribute("data-line"))?.includes("Another Desk tab")) throw new Error("Second Desk controller opened a microphone or hid contention");
  await owner.close();
  await competitor.locator("#enable").click();
  await competitor.waitForFunction(() => document.body.dataset.phase === "listening");
  if (await competitor.locator("body").getAttribute("data-microphones") !== "1") throw new Error("Page close did not release Desk controller ownership");
  await competitor.locator("#disable").click();
  if (await competitor.locator("body").getAttribute("data-ended") !== "true") throw new Error("Desk ownership disable left tracks active");
  process.stdout.write('Two real DeskWake controllers: second tab opens no microphone; owner page close permits recovery; disable ends tracks. Passed.\n');
} finally { await browser.close(); server.stop(true); }
