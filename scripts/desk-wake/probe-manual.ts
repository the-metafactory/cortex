import { join } from "node:path";
import { openLoopbackDesk } from "./probe-common";

const { base, browser, context, page } = await openLoopbackDesk(process.argv[2]);
try {
  let transcriptions = 0;
  let playbackRequests = 0;
  context.on("request", request => { if (request.url().endsWith("/api/desk/voice/transcribe")) transcriptions++; });
  const fixture = join(import.meta.dir, "fixtures/hey-ivy.wav");
  await context.route("**/api/desk/voice/speak", route => { playbackRequests++; return route.fulfill({ path: fixture, contentType: "audio/wav" }); });
  await context.addInitScript(() => {
    const streams: MediaStream[] = [];
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      const fixture = await window.createProbeFixture();
      streams.push(fixture.stream);
      return fixture.stream;
    } });
    setInterval(() => { if (document.body) document.body.dataset.activeProbeTracks = String(streams.flatMap(stream => stream.getTracks()).filter(track => track.readyState !== "ended").length); }, 50);
  });
  await page.goto(base);
  const turns: { wakeBefore: string; transcript: string; returnedIdle: boolean }[] = [];
  for (const wakeEnabled of [false, true]) {
    if (wakeEnabled) {
      await page.getByRole("button", { name: "Enable wake", exact: true }).click();
      await page.locator(".desk-wake-control").getByRole("status").filter({ hasText: "Listening for" }).waitFor();
    }
    const wakeBefore = await page.locator(".desk-wake-control").textContent() ?? "";
    await page.locator(".desk-mic").hover();
    await page.mouse.down();
    await page.waitForTimeout(2700);
    await page.mouse.up();
    await page.locator(".desk-voice-said").filter({ hasText: /what needs me/i }).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.querySelector(".desk-voice-answer") !== null && document.querySelector(".desk-voice-phase") === null, undefined, { timeout: 30000 });
    turns.push({ wakeBefore, transcript: await page.locator(".desk-voice-said").textContent() ?? "", returnedIdle: true });
    await page.waitForFunction(() => document.body.dataset.activeProbeTracks === "0");
    await page.locator(".desk-voice-close").click();
  }
  const text = page.getByRole("textbox", { name: "Ask Ivy" });
  await text.fill("Text remains editable after voice capture");
  if (await text.inputValue() !== "Text remains editable after voice capture") throw new Error("Text input was disabled by capture");
  await text.fill("");
  if (transcriptions !== 2 || playbackRequests !== 2) throw new Error("Manual capture duplicated or lost a voice turn");
  process.stdout.write(JSON.stringify({ turns, transcriptions, playbackRequests, textEditable: true, microphoneSource: "generated fixture stream", playback: "test fixture; real configured TTS checked separately" }, null, 2) + "\n");
} finally { await browser.close(); }
