import { z } from "zod";
import { wakeConfigurationError, type DeskWakeOptions } from "../../../../common/types/desk-wake";
import { ownMicrophone } from "./desk-microphone";
import { CommandEndpoint, WakeBuffer, withoutWakePhrase } from "./desk-wake-buffer";

export type WakeState = { phase: "off" } | { phase: "starting" | "listening" | "recording" | "transcribing" | "responding"; line: string } | { phase: "unavailable"; line: string };
const WorkerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.enum(["wake", "processed"]), through: z.number(), epoch: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export interface WakeDependencies {
  state(state: WakeState): void;
  transcribe(audio: Blob, signal: AbortSignal): Promise<string>;
  answer(text: string): Promise<void>;
  cancelAnswer?: () => void;
  acquire?: (signal: AbortSignal) => Promise<() => void>;
  media?: MediaDevices;
  context?: () => AudioContext;
  worker?: () => Worker;
  recorder?: (stream: MediaStream) => MediaRecorder;
}

type Recording = { recorder: MediaRecorder; destination: MediaStreamAudioDestinationNode; chunks: Blob[]; endpoint: CommandEndpoint; next: number; sources: Set<AudioBufferSourceNode>; ending: boolean };

export class DeskWake {
  private abort = new AbortController();
  private audio: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private release: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private recording: Recording | null = null;
  private ring: WakeBuffer | null = null;
  private current: WakeState = { phase: "off" };
  private epoch = 0;
  private sent = 0;
  private processed = 0;
  private inFlight = false;
  private pending: Float32Array[] = [];
  private pendingSize = 0;
  private heartbeat = 0;
  private entered = 0;
  constructor(private readonly options: DeskWakeOptions, private readonly deps: WakeDependencies) {}
  private set(state: WakeState): void { this.current = state; this.deps.state(state); this.entered = performance.now(); }
  private fail(error: unknown): void {
    const line = error instanceof Error ? error.message : String(error);
    this.disable();
    this.set({ phase: "unavailable", line: `${line} Disable and enable wake to try again.` });
  }
  async enable(): Promise<void> {
    this.disable();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.set({ phase: "starting", line: "Preparing local wake detection…" });
    try {
      const error = wakeConfigurationError(this.options);
      if (error) throw new Error(error);
      this.release = await (this.deps.acquire ?? ownMicrophone)(signal);
      signal.throwIfAborted();
      const stream = await (this.deps.media ?? navigator.mediaDevices).getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (signal.aborted) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      for (const track of stream.getTracks()) track.addEventListener("ended", () => this.fail(new Error("The microphone was lost or permission was revoked.")), { signal });
      const audio = (this.deps.context ?? (() => new AudioContext()))();
      this.audio = audio;
      await audio.resume();
      signal.throwIfAborted();
      audio.addEventListener("statechange", () => { if (!signal.aborted && audio.state !== "running") this.fail(new Error("Audio processing is suspended. Wake is not listening.")); }, { signal });
      await audio.audioWorklet.addModule("/wake/capture.js");
      signal.throwIfAborted();
      this.ring = new WakeBuffer(Math.ceil(audio.sampleRate * this.options.preRollMs / 1000));
      this.worker = (this.deps.worker ?? (() => new Worker("/wake/worker.js")))();
      this.worker.onerror = () => this.fail(new Error("Local wake worker failed. Rebuild the dashboard if assets are missing."));
      this.worker.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (signal.aborted) return;
        const parsed = WorkerMessage.safeParse(data);
        if (!parsed.success) { this.fail(new Error("Invalid wake worker message.")); return; }
        const message = parsed.data;
        if (message.type === "error") this.fail(new Error(message.message));
        else if (message.type === "ready") this.listen();
        else if (message.epoch === this.epoch) {
          if (message.type === "wake" && this.current.phase === "listening") {
            const lag = (this.sent - message.through) / audio.sampleRate * 1000;
            if (lag > this.options.preRollMs / 2) this.fail(new Error("Wake processing fell behind. Wake is not listening."));
            else this.beginRecording();
          } else if (message.type === "processed") {
            this.processed = message.through;
            this.heartbeat = performance.now();
            this.inFlight = false;
            this.sendPending();
          }
        }
      };
      this.source = audio.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(audio, "desk-wake-capture");
      this.node.port.onmessage = ({ data }: MessageEvent<unknown>) => {
        this.node?.port.postMessage("ack");
        if (signal.aborted) return;
        if (!data || typeof data !== "object" || !("samples" in data) || !(data.samples instanceof Float32Array) || !("dropped" in data) || typeof data.dropped !== "number") { this.fail(new Error("Invalid microphone audio frame.")); return; }
        if (data.dropped > 0 && (this.current.phase === "listening" || this.current.phase === "recording")) { this.fail(new Error("Microphone processing was suspended and audio was lost. Wake is not listening.")); return; }
        this.pcm(data.samples);
      };
      this.source.connect(this.node);
      this.node.connect(audio.destination);
      this.worker.postMessage({ type: "init", options: this.options });
      this.timer = setInterval(() => {
        if (signal.aborted) return;
        const now = performance.now();
        if (this.current.phase === "starting" && now - this.entered > 45000) this.fail(new Error("Wake initialization timed out."));
        else if (this.current.phase === "listening" && now - this.heartbeat > 3000) this.fail(new Error("Microphone audio or wake processing stopped. Wake is not listening."));
        else if (this.current.phase === "recording" && !this.recording?.ending && now - this.heartbeat > 3000) this.fail(new Error("Microphone audio stopped during command capture."));
      }, 500);
      window.addEventListener("pagehide", () => this.disable(), { signal });
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && this.current.phase === "listening" && performance.now() - this.heartbeat > 3000) this.fail(new Error("Audio processing became stale while the page was hidden.")); }, { signal });
    } catch (error) { if (!signal.aborted) this.fail(error); }
  }
  private listen(): void {
    this.epoch++;
    this.pending = []; this.pendingSize = 0; this.sent = 0; this.processed = 0; this.inFlight = false;
    this.ring?.clear();
    this.heartbeat = performance.now();
    this.worker?.postMessage({ type: "reset", epoch: this.epoch });
    this.set({ phase: "listening", line: `Listening for “${this.options.phrase}”` });
  }
  private sendPending(): void {
    if (this.inFlight || this.current.phase !== "listening" || !this.pendingSize || !this.audio) return;
    const samples = new Float32Array(this.pendingSize);
    let at = 0;
    for (const frame of this.pending) { samples.set(frame, at); at += frame.length; }
    this.pending = []; this.pendingSize = 0;
    this.inFlight = true;
    this.worker?.postMessage({ type: "audio", samples, rate: this.audio.sampleRate, through: this.sent }, [samples.buffer]);
  }
  private pcm(samples: Float32Array): void {
    if (!this.audio) return;
    if (this.current.phase === "listening") {
      this.ring?.push(samples);
      this.sent += samples.length;
      this.pending.push(samples);
      this.pendingSize += samples.length;
      if ((this.sent - this.processed) / this.audio.sampleRate * 1000 > this.options.preRollMs) { this.fail(new Error("Local wake processing cannot keep up with audio.")); return; }
      this.sendPending();
    } else if (this.current.phase === "recording" && this.recording && !this.recording.ending) {
      this.heartbeat = performance.now();
      this.replay(samples, this.recording);
      const end = this.recording.endpoint.push(samples, this.audio.sampleRate);
      if (end !== "continue") void this.finishRecording();
    }
  }
  private replay(samples: Float32Array, recording: Recording): void {
    const audio = this.audio;
    if (!audio) return;
    const buffer = audio.createBuffer(1, samples.length, audio.sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(recording.destination);
    recording.sources.add(source);
    source.onended = () => { source.disconnect(); recording.sources.delete(source); };
    const at = Math.max(audio.currentTime + 0.02, recording.next);
    source.start(at);
    recording.next = at + samples.length / audio.sampleRate;
  }
  private beginRecording(): void {
    const audio = this.audio;
    if (!audio || this.recording) return;
    try {
      const destination = audio.createMediaStreamDestination();
      const recorder = (this.deps.recorder ?? (stream => new MediaRecorder(stream)))(destination.stream);
      const recording: Recording = { recorder, destination, chunks: [], endpoint: new CommandEndpoint(this.options), next: audio.currentTime + 0.05, sources: new Set(), ending: false };
      this.recording = recording;
      recorder.ondataavailable = event => { if (!this.abort.signal.aborted && event.data.size) recording.chunks.push(event.data); };
      recorder.onerror = () => this.fail(new Error("The browser could not record the command."));
      recorder.start();
      this.set({ phase: "recording", line: "Recording your command…" });
      const before = this.ring?.take();
      if (before?.length) this.replay(before, recording);
      this.ring?.clear();
      this.pending = []; this.pendingSize = 0;
      this.heartbeat = performance.now();
    } catch (error) { this.fail(error); }
  }
  private async finishRecording(): Promise<void> {
    const recording = this.recording;
    const audio = this.audio;
    if (!recording || recording.ending || !audio) return;
    recording.ending = true;
    const signal = this.abort.signal;
    try {
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => { if (this.drainTimer) clearTimeout(this.drainTimer); this.drainTimer = null; reject(signal.reason); };
        signal.addEventListener("abort", aborted, { once: true });
        this.drainTimer = setTimeout(() => { signal.removeEventListener("abort", aborted); this.drainTimer = null; resolve(); }, Math.max(0, (recording.next - audio.currentTime) * 1000) + 100);
      });
      signal.throwIfAborted();
      const clip = await new Promise<Blob>((resolve, reject) => {
        const aborted = (): void => { clearTimeout(timeout); reject(signal.reason); };
        const timeout = setTimeout(() => { signal.removeEventListener("abort", aborted); reject(new Error("The browser did not finish recording.")); }, 3000);
        signal.addEventListener("abort", aborted, { once: true });
        recording.recorder.onstop = () => { clearTimeout(timeout); signal.removeEventListener("abort", aborted); resolve(new Blob(recording.chunks, { type: recording.recorder.mimeType || "audio/webm" })); };
        recording.recorder.stop();
      });
      this.clearRecording();
      signal.throwIfAborted();
      if (!clip.size) { this.listen(); return; }
      this.set({ phase: "transcribing", line: "Transcribing your command…" });
      const said = withoutWakePhrase(await this.deps.transcribe(clip, signal), this.options.phrase);
      signal.throwIfAborted();
      if (!said) { this.listen(); return; }
      this.set({ phase: "responding", line: "Answering…" });
      await this.deps.answer(said);
      signal.throwIfAborted();
      this.listen();
    } catch (error) { if (!signal.aborted) this.fail(error); }
  }
  private clearRecording(): void {
    const recording = this.recording;
    this.recording = null;
    if (!recording) return;
    recording.recorder.ondataavailable = null;
    recording.recorder.onstop = null;
    recording.recorder.onerror = null;
    if (recording.recorder.state !== "inactive") recording.recorder.stop();
    for (const source of recording.sources) { source.stop(); source.disconnect(); }
    recording.destination.disconnect();
    recording.destination.stream.getTracks().forEach(track => track.stop());
    recording.chunks.length = 0;
  }
  disable(): void {
    if (this.current.phase === "responding") this.deps.cancelAnswer?.();
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.timer = null; this.drainTimer = null;
    this.clearRecording();
    this.worker?.terminate(); this.worker = null;
    this.node?.disconnect(); this.node = null;
    this.source?.disconnect(); this.source = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.audio) void this.audio.close().catch(() => undefined);
    this.audio = null;
    this.ring?.clear(); this.ring = null;
    this.pending = []; this.pendingSize = 0;
    this.release?.(); this.release = null;
    this.set({ phase: "off" });
  }
}
