import type { VoiceState } from "../hooks/use-desk-voice";
import type { WakeState } from "../lib/desk-wake";
import "./desk-voice.css";

const PHASE_LABEL: Record<VoiceState["phase"], string> = {
  idle: "",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Answering…",
};

export function WakeControl({ state, onToggle }: { state: WakeState; onToggle: () => void }) {
  const active = state.phase !== "off" && state.phase !== "unavailable";
  return <div className="desk-wake-control">
    <button type="button" aria-pressed={active} onClick={onToggle}>{active ? "Disable wake" : "Enable wake"}</button>
    <span role="status" aria-live="polite">{state.phase === "off" ? "Wake is off. Audio stays local until a command is captured." : state.line}</span>
  </div>;
}

export function MicButton({ phase, onStart, onStop }: { phase: VoiceState["phase"]; onStart: () => void; onStop: () => void }) {
  const live = phase === "listening";
  return (
    <button
      type="button"
      className={`desk-mic${live ? " live" : ""}`}
      aria-label={live ? "Release to send" : "Hold to talk (or hold Space)"}
      aria-pressed={live}
      title="Hold to talk, or hold Space"
      onPointerDown={(e) => {
        e.preventDefault();
        onStart();
      }}
      onPointerUp={onStop}
      onPointerLeave={() => live && onStop()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.repeat) {
          e.preventDefault();
          onStart();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter") onStop();
      }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" fill="currentColor" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export function VoicePanel({ state, onDismiss }: { state: VoiceState; onDismiss: () => void }) {
  if (state.phase === "idle" && !state.transcript && !state.answer && !state.fallback) return null;
  return (
    <div className="desk-voice" role="status" aria-live="polite">
      {state.phase !== "idle" && <div className="desk-voice-phase">{PHASE_LABEL[state.phase]}</div>}
      {state.transcript && <p className="desk-voice-said">“{state.transcript}”</p>}
      {state.answer && <p className="desk-voice-answer">{state.answer}</p>}
      {state.fallback && <p className="desk-voice-fallback">{state.fallback}</p>}
      {state.phase === "idle" && (
        <button type="button" className="desk-voice-close" aria-label="Close" onClick={onDismiss}>×</button>
      )}
    </div>
  );
}
