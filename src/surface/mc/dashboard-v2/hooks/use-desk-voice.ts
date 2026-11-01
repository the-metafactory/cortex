import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeskVoice } from "../../desk/voice";
import { speechFailureLine, speechFor, voiceTurn, transcribeClip, type Listening, type SpeechEnv, type SpeechProviders } from "../lib/desk-speech";
import { DeskWake, type WakeState } from "../lib/desk-wake";
import { ownMicrophone } from "../lib/desk-microphone";

export type VoicePhase = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceState {
  phase: VoicePhase;
  transcript: string;
  answer: string | null;
  fallback: string | null;
}

export const VOICE_IDLE: VoiceState = { phase: "idle", transcript: "", answer: null, fallback: null };

export interface VoiceHandlers {
  answer: (said: string) => Promise<string>;
  briefing: () => string;
  isBriefing: (said: string) => boolean;
  typeInstead: () => void;
}

const CONTROLS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"]);

export const ownsSpace = (target: EventTarget | null): boolean => {
  const el = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null; classList?: { contains(c: string): boolean } } | null;
  if (el?.classList?.contains("desk-mic")) return false;
  return el?.isContentEditable === true || CONTROLS.has(el?.tagName ?? "") || Boolean(el?.getAttribute?.("role"));
};

export function useDeskVoice(voice: DeskVoice, handlers: VoiceHandlers, env: SpeechEnv | undefined = typeof window === "undefined" ? undefined : (window as unknown as SpeechEnv)) {
  const [state, setState] = useState<VoiceState>(VOICE_IDLE);
  const { enabled, input, output } = voice;
  const providers = useMemo<SpeechProviders | null>(() => (env && enabled ? speechFor({ enabled, input, output }, env) : null), [env, enabled, input, output]);
  const session = useRef<Listening | null>(null);
  const turnId = useRef(0);
  const wake = useRef<DeskWake | null>(null);
  const [wakeState, setWakeState] = useState<WakeState>({ phase: "off" });
  const wakeKey = JSON.stringify(voice.wake);
  const manualAbort = useRef<AbortController | null>(null);
  const manualRelease = useRef<(() => void) | null>(null);
  const manualReleases = useRef(new WeakMap<AbortController, () => void>());
  const latest = useRef(handlers);
  latest.current = handlers;

  const fail = useCallback((line: string): void => {
    setState({ ...VOICE_IDLE, fallback: `${line} Type instead.` });
    latest.current.typeInstead();
  }, []);

  const answerTranscript = useCallback(async (said: string, id: number): Promise<void> => {
    const current = (): boolean => turnId.current === id;
    if (!current()) return;
    if (!said) {
      setState({ ...VOICE_IDLE, fallback: "I did not catch that. Hold Space and try again." });
      return;
    }
    setState((s) => ({ ...s, transcript: said, phase: "speaking" }));
    const { briefing, isBriefing, answer } = latest.current;
    const turn = await voiceTurn(said, {
      briefing, isBriefing, ask: answer,
      output: {
        speak: (text) => {
          if (!current()) return Promise.resolve();
          setState((s) => ({ ...s, answer: text }));
          return providers?.output.speak(text) ?? Promise.resolve();
        },
        stop: () => providers?.output.stop(),
      },
    });
    if (current()) setState({ phase: "idle", transcript: said, answer: turn.answer, fallback: turn.fallback });
  }, [providers]);

  const start = useCallback((): void => {
    if (!providers || session.current) return;
    manualAbort.current?.abort(); manualAbort.current = null;
    manualRelease.current?.(); manualRelease.current = null;
    wake.current?.disable();
    turnId.current += 1;
    providers.output.stop();
    try {
      const controller = new AbortController();
      manualAbort.current = controller;
      const started = (async (): Promise<Listening> => {
        const release = typeof navigator !== "undefined" && navigator.locks ? await ownMicrophone(controller.signal) : () => {};
        if (controller.signal.aborted) { release(); controller.signal.throwIfAborted(); }
        manualRelease.current = release;
        manualReleases.current.set(controller, release);
        controller.signal.throwIfAborted();
        return providers.input.listen((transcript) => setState((s) => ({ ...s, transcript })));
      })();
      started.catch((error: unknown) => {
        if (controller.signal.aborted) return;
        session.current = null;
        manualRelease.current?.(); manualRelease.current = null;
        manualAbort.current = null;
        fail(speechFailureLine(error));
      });
      session.current = {
        stop: async () => (await started).stop(),
        cancel: () => { controller.abort(); void started.then(listening => listening.cancel()).catch(() => undefined); },
      };
      setState({ ...VOICE_IDLE, phase: "listening" });
    } catch (err) {
      fail(speechFailureLine(err));
    }
  }, [providers, fail, state.phase]);

  const stop = useCallback(async (): Promise<void> => {
    const listening = session.current;
    if (!providers || !listening) return;
    session.current = null;
    const id = turnId.current;
    const abort = manualAbort.current;
    const releaseManual = (): void => {
      const release = abort ? manualReleases.current.get(abort) : undefined;
      release?.(); abort?.abort();
      if (manualRelease.current === release) manualRelease.current = null;
      if (manualAbort.current === abort) manualAbort.current = null;
    };
    const current = (): boolean => turnId.current === id;
    setState((s) => ({ ...s, phase: "thinking" }));
    let said: string;
    try {
      said = (await listening.stop()).trim();
    } catch (err) {
      releaseManual();
      if (current()) fail(speechFailureLine(err));
      return;
    }
    if (!current()) return;
    try { await answerTranscript(said, id); }
    finally {
      releaseManual();
    }
  }, [providers, fail, answerTranscript]);

  const dismiss = useCallback((): void => {
    turnId.current += 1;
    session.current?.cancel();
    session.current = null;
    manualAbort.current?.abort(); manualAbort.current = null;
    manualRelease.current?.(); manualRelease.current = null;
    wake.current?.disable();
    providers?.output.stop();
    setState(VOICE_IDLE);
  }, [providers]);

  const toggleWake = useCallback((): void => {
    if (wake.current && wakeState.phase !== "off" && wakeState.phase !== "unavailable") {
      dismiss();
      return;
    }
    if (!voice.wake?.enabled || !providers || !env || session.current || manualAbort.current || state.phase !== "idle") return;
    if (input !== "elevenlabs") { setWakeState({ phase: "unavailable", line: "Wake needs the configured ElevenLabs transcription adapter. Push-to-talk remains available." }); return; }
    const controller = new DeskWake(voice.wake, {
      state: setWakeState,
      transcribe: (audio, signal) => transcribeClip(env, audio, signal),
      answer: async (said) => { const id = ++turnId.current; await answerTranscript(said, id); },
      cancelAnswer: () => { turnId.current++; providers.output.stop(); setState(VOICE_IDLE); },
    });
    wake.current = controller;
    void controller.enable();
  }, [voice.wake, providers, env, input, state.phase, wakeState.phase, dismiss, answerTranscript]);

  useEffect(() => {
    return () => {
      turnId.current++;
      session.current?.cancel(); session.current = null;
      manualAbort.current?.abort(); manualAbort.current = null;
      manualRelease.current?.(); manualRelease.current = null;
      wake.current?.disable(); wake.current = null;
      providers?.output.stop();
    };
  }, [providers, wakeKey]);

  useEffect(() => {
    if (!providers) return;
    const down = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey || ownsSpace(e.target)) return;
      e.preventDefault();
      if (!e.repeat) start();
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || !session.current) return;
      e.preventDefault();
      void stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [providers, start, stop]);

  return { available: providers !== null, state, start, stop: () => void stop(), dismiss, wakeState, wakeConfigured: enabled && voice.wake?.enabled === true, toggleWake };
}
