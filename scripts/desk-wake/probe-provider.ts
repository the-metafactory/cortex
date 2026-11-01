import { chromium } from "playwright";
import { join } from "node:path";

const base = process.argv[2];
if (!base || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("Provide the loopback Desk URL to test its configured voice provider");
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const context = await browser.newContext();
  await context.route("**/__wake_probe_speech.wav", route => route.fulfill({ path: join(import.meta.dir, "fixtures/hey-ivy.wav"), contentType: "audio/wav" }));
  const page = await context.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const audio = new AudioContext();
    await audio.resume();
    const buffer = await audio.decodeAudioData(await (await fetch("/__wake_probe_speech.wav")).arrayBuffer());
    const destination = audio.createMediaStreamDestination();
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    const recorder = new MediaRecorder(destination.stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.start();
    await new Promise<void>(resolve => { source.onended = () => resolve(); source.start(); });
    await new Promise(resolve => setTimeout(resolve, 200));
    await new Promise<void>(resolve => { recorder.onstop = () => resolve(); recorder.stop(); });
    const clip = new Blob(chunks, { type: recorder.mimeType });
    destination.stream.getTracks().forEach(track => track.stop());
    source.disconnect(); destination.disconnect(); await audio.close();
    const response = await fetch("/api/desk/voice/transcribe", { method: "POST", headers: { "content-type": clip.type }, body: clip });
    const body: unknown = await response.json();
    if (!response.ok || !body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") throw new Error(`Configured transcription refused the generated browser clip: HTTP ${response.status}`);
    const speech = await fetch("/api/desk/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Wake voice integration test completed." }) });
    if (!speech.ok) throw new Error(`Configured speech output refused the test: HTTP ${speech.status}`);
    const url = URL.createObjectURL(await speech.blob());
    const player = new Audio(url);
    try {
      await new Promise<void>((resolve, reject) => { player.onended = () => resolve(); player.onerror = () => reject(new Error("Generated speech playback failed")); void player.play().catch(reject); });
    } finally { URL.revokeObjectURL(url); }
    return { transcriptionStatus: response.status, text: body.text, clipBytes: clip.size, mime: clip.type, speechStatus: speech.status, playbackEnded: true, source: "synthesized fixture replayed through browser MediaRecorder; no microphone access" };
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!/what needs me/i.test(result.text)) throw new Error("Configured adapter did not transcribe the fixture's command");
} finally { await browser.close(); }
