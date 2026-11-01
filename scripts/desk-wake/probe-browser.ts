import { chromium } from "playwright";
import { join } from "node:path";
import { wakeAssetResponse } from "../../src/surface/mc/desk/wake-assets";
import { handleDeskTranscribe } from "../../src/surface/mc/api/desk-voice";
import { HandledLedger } from "../../src/surface/mc/desk/actions";

const root = join(import.meta.dir, "../..");
const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "browser-probe.ts")], target: "browser" });
if (!bundle.success || !bundle.outputs[0]) throw new Error("Browser probe failed to build");
let adapterCalls = 0;
let receivedBytes = 0;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/wake/")) return wakeAssetResponse(path, join(root, "dist/dashboard-v2"));
    if (path === "/probe.js") return new Response(bundle.outputs[0]);
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
  await owner.goto(new URL("/blank", server.url).toString());
  await competitor.goto(new URL("/blank", server.url).toString());
  await owner.evaluate(() => new Promise<void>((ready) => {
    void navigator.locks.request("cortex-desk-microphone", async () => {
      ready();
      await new Promise<void>((release) => document.addEventListener("release-probe", () => release(), { once: true }));
    });
  }));
  const secondOwned = await competitor.evaluate(() => navigator.locks.request("cortex-desk-microphone", { ifAvailable: true }, lock => Boolean(lock)));
  if (secondOwned) throw new Error("Two tabs acquired microphone ownership");
  await owner.close();
  const recovered = await competitor.evaluate(() => navigator.locks.request("cortex-desk-microphone", () => true));
  if (!recovered) throw new Error("Page close did not release microphone ownership");
  process.stdout.write('Two-tab exclusion and page-close ownership recovery: passed\n');
} finally { await browser.close(); server.stop(true); }
