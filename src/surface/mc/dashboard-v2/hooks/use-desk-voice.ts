import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeskVoice } from "../../desk/voice";
import { SpeechFailure, speechFor, voiceTurn, type Listening, type SpeechEnv, type SpeechProviders } from "../lib/desk-speech";

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

export const isTyping = (target: EventTarget | null): boolean => {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return el?.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName ?? "");
};

export function useDeskVoice(voice: DeskVoice, handlers: VoiceHandlers, env: SpeechEnv | undefined = typeof window === "undefined" ? undefined : (window as unknown as SpeechEnv)) {
  const [state, setState] = useState<VoiceState>(VOICE_IDLE);
  const { enabled, input, output } = voice;
  const providers = useMemo<SpeechProviders | null>(() => (env && enabled ? speechFor({ enabled, input, output }, env) : null), [env, enabled, input, output]);
  const session = useRef<Listening | null>(null);
  const latest = useRef(handlers);
  latest.current = handlers;

  const fail = useCallback((line: string): void => {
    setState({ ...VOICE_IDLE, fallback: `${line} Type instead.` });
    latest.current.typeInstead();
  }, []);

  const start = useCallback((): void => {
    if (!providers || session.current) return;
    providers.output.stop();
    try {
      session.current = providers.input.listen((transcript) => setState((s) => ({ ...s, transcript })));
      setState({ ...VOICE_IDLE, phase: "listening" });
    } catch (err) {
      fail(err instanceof SpeechFailure ? err.line : String(err));
    }
  }, [providers, fail]);

  const stop = useCallback(async (): Promise<void> => {
    const listening = session.current;
    if (!providers || !listening) return;
    session.current = null;
    setState((s) => ({ ...s, phase: "thinking" }));
    let said: string;
    try {
      said = (await listening.stop()).trim();
    } catch (err) {
      fail(err instanceof SpeechFailure ? err.line : String(err));
      return;
    }
    if (!said) {
      setState({ ...VOICE_IDLE, fallback: "I did not catch that. Hold Space and try again." });
      return;
    }
    setState((s) => ({ ...s, transcript: said, phase: "speaking" }));
    const { briefing, isBriefing, answer } = latest.current;
    const turn = await voiceTurn(said, {
      briefing,
      isBriefing,
      ask: answer,
      output: {
        speak: (text) => {
          setState((s) => ({ ...s, answer: text }));
          return providers.output.speak(text);
        },
        stop: () => providers.output.stop(),
      },
    });
    setState({ phase: "idle", transcript: said, answer: turn.answer, fallback: turn.fallback });
  }, [providers, fail]);

  const dismiss = useCallback((): void => {
    session.current?.cancel();
    session.current = null;
    providers?.output.stop();
    setState(VOICE_IDLE);
  }, [providers]);

  useEffect(() => {
    if (!providers) return;
    const down = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
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

  return { available: providers !== null, state, start, stop: () => void stop(), dismiss };
}
