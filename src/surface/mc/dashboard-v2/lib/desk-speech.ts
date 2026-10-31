import type { DeskVoice } from "../../desk/voice";

export class SpeechFailure extends Error {
  constructor(readonly line: string) {
    super(line);
  }
}

export const speechFailureLine = (err: unknown, fallback: string = String(err)): string => (err instanceof SpeechFailure ? err.line : fallback);

export const NO_ANSWER = "The Desk could not answer that.";

export interface Listening {
  stop(): Promise<string>;
  cancel(): void;
}

export interface SpeechIn {
  listen(onInterim: (text: string) => void): Listening;
}

export interface SpeechOut {
  speak(text: string): Promise<void>;
  stop(): void;
}

export interface SpeechProviders {
  input: SpeechIn;
  output: SpeechOut;
}

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResultList {
  length: number;
  [index: number]: { 0: RecognitionAlternative } | undefined;
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: RecognitionResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

export interface SpeechEnv {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
  navigator?: { language?: string; mediaDevices?: { getUserMedia(c: MediaStreamConstraints): Promise<MediaStream> } };
  MediaRecorder?: typeof MediaRecorder;
  Audio?: typeof Audio;
  URL?: typeof URL;
  fetch?: typeof fetch;
}

export const NO_RECOGNITION = "Voice is off: this browser has no speech recognition.";
export const NO_SYNTHESIS = "Voice is off: this browser cannot speak.";
export const NO_MIC = "Voice is off: the Desk may not use the microphone.";
export const NOT_ANSWERED = "Voice is off: Mission Control did not answer.";

const RECOGNITION_ERRORS: Record<string, string> = {
  "not-allowed": NO_MIC,
  "service-not-allowed": NO_MIC,
  "audio-capture": "Voice is off: no microphone was found.",
  network: "Voice is off: the browser's speech service is unreachable.",
};

const transcriptOf = (results: RecognitionResultList): string => {
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) parts.push(results[i]?.[0].transcript ?? "");
  return parts.join("").replace(/\s+/g, " ").trim();
};

export function browserInput(env: SpeechEnv): SpeechIn {
  return {
    listen(onInterim) {
      const Ctor = env.SpeechRecognition ?? env.webkitSpeechRecognition;
      if (!Ctor) throw new SpeechFailure(NO_RECOGNITION);
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = env.navigator?.language ?? "en-US";
      let text = "";
      let failure: string | null = null;
      let ended = false;
      let onEnded: (() => void) | null = null;
      rec.onresult = (e) => {
        text = transcriptOf(e.results);
        onInterim(text);
      };
      rec.onerror = (e) => {
        if (e.error !== "no-speech" && e.error !== "aborted") failure = RECOGNITION_ERRORS[e.error] ?? `Voice is off: speech recognition failed (${e.error}).`;
      };
      rec.onend = () => {
        ended = true;
        onEnded?.();
      };
      rec.start();
      return {
        stop: () =>
          new Promise<string>((resolve, reject) => {
            const settle = (): void => (failure ? reject(new SpeechFailure(failure)) : resolve(text));
            if (ended) return settle();
            onEnded = settle;
            rec.stop();
          }),
        cancel: () => rec.abort(),
      };
    },
  };
}

export function browserOutput(env: SpeechEnv): SpeechOut {
  return {
    speak(text) {
      const synth = env.speechSynthesis;
      const Utterance = env.SpeechSynthesisUtterance;
      if (!synth || !Utterance) return Promise.reject(new SpeechFailure(NO_SYNTHESIS));
      return new Promise<void>((resolve, reject) => {
        const u = new Utterance(text);
        u.lang = env.navigator?.language ?? "en-US";
        u.onend = () => resolve();
        u.onerror = (e) => (e.error === "interrupted" || e.error === "canceled" ? resolve() : reject(new SpeechFailure(`Voice is off: the browser could not speak (${e.error}).`)));
        synth.cancel();
        synth.speak(u);
      });
    },
    stop() {
      env.speechSynthesis?.cancel();
    },
  };
}

const errorLine = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Voice is off: the request failed (HTTP ${res.status}).`;
};

const post = async (env: SpeechEnv, path: string, init: RequestInit): Promise<Response> => {
  let res: Response;
  try {
    res = await (env.fetch ?? fetch)(path, { method: "POST", ...init });
  } catch {
    throw new SpeechFailure(NOT_ANSWERED);
  }
  if (!res.ok) throw new SpeechFailure(await errorLine(res));
  return res;
};

export function elevenLabsInput(env: SpeechEnv): SpeechIn {
  return {
    listen(onInterim) {
      const media = env.navigator?.mediaDevices;
      const Recorder = env.MediaRecorder;
      if (!media || !Recorder) throw new SpeechFailure(NO_MIC);
      const chunks: Blob[] = [];
      const started = media.getUserMedia({ audio: true }).then(
        (stream) => {
          const recorder = new Recorder(stream);
          recorder.ondataavailable = (e) => chunks.push(e.data);
          recorder.start();
          return { recorder, stream };
        },
        () => {
          throw new SpeechFailure(NO_MIC);
        },
      );
      started.catch(() => undefined);
      onInterim("");
      const finish = async (): Promise<Blob> => {
        const { recorder, stream } = await started;
        if (recorder.state !== "inactive") {
          await new Promise<void>((resolve) => {
            recorder.onstop = () => resolve();
            recorder.stop();
          });
        }
        stream.getTracks().forEach((t) => t.stop());
        return new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      };
      return {
        async stop() {
          const audio = await finish();
          if (audio.size === 0) return "";
          const res = await post(env, "/api/desk/voice/transcribe", { headers: { "content-type": audio.type || "audio/webm" }, body: audio });
          const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
          return typeof body?.text === "string" ? body.text : "";
        },
        cancel() {
          void finish().catch(() => undefined);
        },
      };
    },
  };
}

export function elevenLabsOutput(env: SpeechEnv): SpeechOut {
  let playing: HTMLAudioElement | null = null;
  return {
    async speak(text) {
      const res = await post(env, "/api/desk/voice/speak", { headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const AudioCtor = env.Audio;
      const urls = env.URL;
      if (!AudioCtor || !urls) throw new SpeechFailure(NO_SYNTHESIS);
      const src = urls.createObjectURL(await res.blob());
      const audio = new AudioCtor(src);
      playing = audio;
      try {
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onpause = () => resolve();
          audio.onerror = () => reject(new SpeechFailure("Voice is off: the browser could not play the answer."));
          audio.play().catch(() => reject(new SpeechFailure("Voice is off: the browser blocked audio playback.")));
        });
      } finally {
        urls.revokeObjectURL(src);
        if (playing === audio) playing = null;
      }
    },
    stop() {
      playing?.pause();
    },
  };
}

export function speechFor(voice: DeskVoice, env: SpeechEnv): SpeechProviders {
  return {
    input: voice.input === "elevenlabs" ? elevenLabsInput(env) : browserInput(env),
    output: voice.output === "elevenlabs" ? elevenLabsOutput(env) : browserOutput(env),
  };
}

export interface VoiceTurnDeps {
  briefing: () => string;
  isBriefing: (said: string) => boolean;
  ask: (said: string) => Promise<string>;
  output: SpeechOut;
}

export interface VoiceTurn {
  answer: string;
  fallback: string | null;
}

export async function voiceTurn(said: string, deps: VoiceTurnDeps): Promise<VoiceTurn> {
  let answer: string;
  try {
    answer = deps.isBriefing(said) ? deps.briefing() : await deps.ask(said);
  } catch {
    return { answer: NO_ANSWER, fallback: null };
  }
  try {
    await deps.output.speak(answer);
    return { answer, fallback: null };
  } catch (err) {
    return { answer, fallback: `${speechFailureLine(err, NO_SYNTHESIS)} Answering in text.` };
  }
}
