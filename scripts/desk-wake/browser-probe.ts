import { fakeWorker } from "./fake-worker";
import { DeskWake, type WakeState } from "../../src/surface/mc/dashboard-v2/lib/desk-wake";
import { DeskWakeSchema, WAKE_BPE_SHA } from "../../src/common/types/desk-wake";
import { transcribeClip } from "../../src/surface/mc/dashboard-v2/lib/desk-speech";
import { ownMicrophone } from "../../src/surface/mc/dashboard-v2/lib/desk-microphone";
import { probeEngine } from "./engine-probe";

const options = DeskWakeSchema.parse({ enabled: true, phrase: "Hey Ivy", tokens: ["▁HE", "Y", "▁I", "V", "Y"], tokenizerSha256: WAKE_BPE_SHA, preRollMs: 2000, silenceMs: 500, maxCommandMs: 3000 });
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const assert = (claim: unknown, message: string): void => { if (!claim) throw new Error(message); };
const until = async (claim: () => boolean, timeout = 15000): Promise<void> => {
  const start = performance.now();
  while (!claim()) { if (performance.now() - start > timeout) throw new Error("Probe timed out"); await wait(20); }
};

async function run(): Promise<unknown> {
  const states: WakeState[] = [];
  const captures: MediaStream[] = [];
  const generator = new AudioContext();
  const mic = async (): Promise<MediaStream> => {
    await generator.resume();
    const destination = generator.createMediaStreamDestination();
    const oscillator = generator.createOscillator();
    oscillator.frequency.value = 880;
    const gain = generator.createGain();
    gain.gain.value = 0.2;
    oscillator.connect(gain).connect(destination);
    oscillator.start(); oscillator.stop(generator.currentTime + 1.6);
    captures.push(destination.stream);
    return destination.stream;
  };
  let uploads = 0;
  let said = "";
  let decodedDuration = 0;
  let preRollPeak = 0;
  let processedMessages = 0;
  const wake = new DeskWake(options, {
    state: state => { states.push(state); document.body.dataset.state = JSON.stringify(states); },
    media: { getUserMedia: mic } as MediaDevices,
    worker: () => { const worker = fakeWorker(true); worker.addEventListener("message", () => { processedMessages++; }); return worker; },
    transcribe: async (blob, signal) => {
      uploads++;
      const decoded = await generator.decodeAudioData(await blob.arrayBuffer());
      decodedDuration = decoded.duration;
      preRollPeak = decoded.getChannelData(0).slice(0, Math.floor(decoded.sampleRate * 0.6)).reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
      return transcribeClip({ fetch }, blob, signal);
    },
    answer: async text => { said = text; const before = processedMessages; await wait(200); assert(before === processedMessages, "Detector kept processing assistant playback"); },
  });
  await wake.enable();
  await until(() => said.length > 0 && states.at(-1)?.phase === "listening");
  assert(uploads === 1 && said === "what needs me", "Duplicate wake made duplicate turn or phrase was not stripped");
  assert(decodedDuration > 1.5 && preRollPeak > 0.05, "MediaRecorder lost command pre-roll");
  assert(decodedDuration < 2.05, "Audio preceding the detected wake phrase was included in the upload");
  wake.disable();
  const releaseManual = await ownMicrophone(new AbortController().signal);
  releaseManual();
  assert(captures.length > 0 && captures.every(stream => stream.getTracks().every(track => track.readyState === "ended")), "Disable left microphone tracks active");
  await generator.close();

  let denied = "";
  const refusal = new DeskWake(options, { state: state => { if (state.phase === "unavailable") denied = state.line; }, media: { getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")) } as MediaDevices, transcribe: () => { throw new Error("Denied permission must not upload"); }, answer: () => Promise.resolve() });
  await refusal.enable();
  assert(denied.includes("Permission denied"), "Permission denial was hidden");
  refusal.disable();

  const silentContext = new AudioContext();
  const silentStates: WakeState[] = [];
  const silent = new DeskWake(options, { state: state => { silentStates.push(state); }, media: { getUserMedia: async () => { await silentContext.resume(); return silentContext.createMediaStreamDestination().stream; } } as MediaDevices, worker: () => fakeWorker(false), transcribe: () => { throw new Error("Non-wake audio uploaded"); }, answer: () => Promise.resolve() });
  await silent.enable();
  await until(() => silentStates.at(-1)?.phase === "listening");
  await wait(600);
  assert(silentStates.at(-1)?.phase === "listening", "Non-wake audio did not stay listening");
  silent.disable(); await silentContext.close();

  const lifecycle: string[] = [];
  for (const kind of ["suspend", "lost", "pagehide", "capture-cancel", "stale"] as const) {
    const input = new AudioContext();
    const contexts: AudioContext[] = [];
    const streams: MediaStream[] = [];
    const seen: WakeState[] = [];
    const listener = new DeskWake(options, {
      state: state => seen.push(state),
      context: () => { const ctx = new AudioContext(); contexts.push(ctx); return ctx; },
      media: { getUserMedia: async () => { await input.resume(); const stream = input.createMediaStreamDestination().stream; streams.push(stream); return stream; } } as MediaDevices,
      worker: () => kind === "stale" ? fakeWorker(false, false) : fakeWorker(kind === "capture-cancel"),
      transcribe: () => { throw new Error("Cancelled or broken capture uploaded audio"); },
      answer: () => Promise.resolve(),
    });
    await listener.enable();
    await until(() => seen.at(-1)?.phase === "listening");
    if (kind === "suspend") { const context = contexts[0]; if (!context) throw new Error("No AudioContext"); await context.suspend(); }
    if (kind === "lost") streams[0]?.getAudioTracks()[0]?.dispatchEvent(new Event("ended"));
    if (kind === "pagehide") window.dispatchEvent(new Event("pagehide"));
    if (kind === "capture-cancel") { await until(() => seen.at(-1)?.phase === "recording"); listener.disable(); }
    if (kind === "stale") await until(() => seen.at(-1)?.phase === "unavailable");
    if (kind !== "pagehide" && kind !== "capture-cancel") await until(() => seen.at(-1)?.phase === "unavailable");
    assert(streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")), `${kind} left microphone tracks active`);
    listener.disable(); await input.close();
    lifecycle.push(kind);
  }
  const engine = await probeEngine();
  const realInput = new AudioContext();
  await realInput.resume();
  const reference = await realInput.decodeAudioData(await (await fetch("/fixtures/public-speech.wav")).arrayBuffer());
  const destination = realInput.createMediaStreamDestination();
  const referenceSource = realInput.createBufferSource();
  referenceSource.buffer = reference;
  referenceSource.connect(destination);
  let sourceStarted = false;
  let realTranscript = "";
  let realAnswer = "";
  let realClipBytes = 0;
  let realClipDuration = 0;
  const realStates: WakeState[] = [];
  const real = new DeskWake(DeskWakeSchema.parse({ ...options, phrase: "EARLY NIGHTFALL", tokens: ["▁E", "AR", "LY", "▁", "N", "IGHT", "F", "AL", "L"], maxCommandMs: 15000 }), {
    state: state => { realStates.push(state); if (state.phase === "listening" && !sourceStarted) { sourceStarted = true; referenceSource.start(realInput.currentTime + 0.1); } },
    media: { getUserMedia: () => Promise.resolve(destination.stream) } as MediaDevices,
    transcribe: async (clip, signal) => {
      realClipBytes = clip.size;
      const decoded = await realInput.decodeAudioData(await clip.arrayBuffer());
      realClipDuration = decoded.duration;
      const response = await fetch("/__engine_transcribe", { method: "POST", headers: { "content-type": clip.type }, body: clip, signal });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") throw new Error("Real-engine browser clip transcription failed");
      realTranscript = body.text;
      if (!/\bearly nightfall\b/i.test(realTranscript) || !/yellow lamps/i.test(realTranscript)) throw new Error(`Keyword timestamp did not preserve the matched phrase and following speech: ${realTranscript}`);
      return realTranscript;
    },
    answer: text => { realAnswer = text; return Promise.resolve(); },
  });
  try {
    await real.enable();
    await until(() => { const state = realStates.at(-1); if (state?.phase === "unavailable") throw new Error(state.line); return realAnswer.length > 0 && state?.phase === "listening"; }, 60000);
    assert(realClipBytes > 0 && realClipDuration > 1, "Real-engine capture lost the command stream");
  } finally { real.disable(); await realInput.close(); }
  return { uploads, said, decodedDuration, preRollPeak, phases: states.map(state => state.phase), denied, teardown: "tracks ended", nonWake: "no upload", playback: "no detector frames", manual: "wake-to-manual lock handoff passed", lifecycle, engine, realEngineCapture: { realTranscript, realAnswer, realClipBytes, realClipDuration, phases: realStates.map(state => state.phase) } };
}

run().then(result => { document.body.dataset.result = JSON.stringify({ ok: true, result }); document.body.textContent = JSON.stringify(result, null, 2); }).catch((error: unknown) => { document.body.dataset.result = JSON.stringify({ ok: false, error: String(error) }); document.body.textContent = String(error); });
