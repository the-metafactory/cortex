import { chromium } from "playwright";
import { join } from "node:path";

declare global {
  interface Window {
    createProbeFixture(): Promise<{ stream: MediaStream; ended: Promise<void>; stop(): Promise<void> }>;
  }
}

export async function openLoopbackDesk(base: string | undefined) {
  if (!base || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("Provide a loopback Desk URL");
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext();
  await context.route("**/__wake_probe_speech.wav", route => route.fulfill({ path: join(import.meta.dir, "fixtures/hey-ivy.wav"), contentType: "audio/wav" }));
  await context.addInitScript(() => {
    window.createProbeFixture = async () => {
      const audio = new AudioContext();
      await audio.resume();
      const buffer = await audio.decodeAudioData(await (await fetch("/__wake_probe_speech.wav")).arrayBuffer());
      const destination = audio.createMediaStreamDestination();
      const source = audio.createBufferSource();
      source.buffer = buffer; source.connect(destination);
      const ended = new Promise<void>(resolve => { source.onended = () => resolve(); });
      source.start(audio.currentTime + 0.1);
      return { stream: destination.stream, ended, stop: async () => {
        destination.stream.getTracks().forEach(track => track.stop());
        source.disconnect(); destination.disconnect();
        if (audio.state !== "closed") await audio.close();
      } };
    };
  });
  return { base, browser, context, page: await context.newPage() };
}
