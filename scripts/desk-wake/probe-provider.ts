import { openLoopbackDesk } from "./probe-common";

const { base, browser, page } = await openLoopbackDesk(process.argv[2]);
try {
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const fixture = await window.createProbeFixture();
    const recorder = new MediaRecorder(fixture.stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.start();
    await fixture.ended;
    await new Promise(resolve => setTimeout(resolve, 200));
    await new Promise<void>(resolve => { recorder.onstop = () => resolve(); recorder.stop(); });
    const clip = new Blob(chunks, { type: recorder.mimeType });
    await fixture.stop();
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
