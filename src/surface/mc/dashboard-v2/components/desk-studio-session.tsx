import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { SessionEndSchema, SessionRequestSchema, StudioSessionSchema, type SessionEnd, type SessionScope, type StudioSession } from "../../desk/studio/session-schema";
import { draftWasRecorded } from "../../desk/studio/session-draft";
import type { DeskVoice } from "../../desk/voice";
import { useDeskVoice } from "../hooks/use-desk-voice";
import { MicButton } from "./desk-voice";
import "./desk-studio-session.css";

const PATH = "/api/desk/studio/session";
const ACTIVE = "desk.studio.session";
const ReplySchema = z.object({ ok: z.boolean(), error: z.string().optional(), session: StudioSessionSchema.optional(), sessions: z.array(StudioSessionSchema).optional(), commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional() });
type RequestBody = z.infer<typeof SessionRequestSchema>;
async function post(body: RequestBody) {
  const response = await fetch(PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: body.action === "end" });
  return ReplySchema.parse(await response.json());
}
const DraftSchema = z.object({ id: z.uuid(), draft: z.string(), reword: z.string(), turn: z.object({ id: z.uuid(), text: z.string() }).nullable().optional(), chosen: SessionEndSchema.nullable().optional() });
function remembered() {
  try { return DraftSchema.safeParse(JSON.parse(sessionStorage.getItem(ACTIVE) ?? "null")).data ?? null; }
  catch { return null; }
}
export type StartDiscussion = (thread: string, scope: SessionScope) => void;

export function useStudioSession(onSaved?: () => void) {
  const saved = useRef(onSaved); saved.current = onSaved;
  const [session, setSession] = useState<StudioSession | null>(null);
  const [recoverable, setRecoverable] = useState<StudioSession[]>([]);
  const [draft, setDraft] = useState(() => remembered()?.draft ?? "");
  const [reword, setReword] = useState(() => remembered()?.reword ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const ending = useRef(false);
  const lastTurn = useRef(remembered()?.turn ?? null);
  const [endingChoice, setEndingChoice] = useState<SessionEnd | null>(() => remembered()?.chosen ?? null);
  const chosen = useRef<SessionEnd | null>(endingChoice);
  const id = useRef<string | null>(remembered()?.id ?? null);
  const terminal = useRef<string | null>(null);
  const latest = useRef({ session, draft, reword }); latest.current = { session, draft, reword };

  const clearSession = useCallback((sessionId: string, expectedDraft: string): void => {
    setError(null);
    try { const local = remembered(); if (local?.id === sessionId && local.draft === expectedDraft) sessionStorage.removeItem(ACTIVE); } catch { setError("The note is saved, but this browser could not remove its draft copy."); }
    id.current = null; lastTurn.current = null; chosen.current = null; setEndingChoice(null);
    setSession(null); setDraft(""); setReword("");
    setRecoverable(xs => xs.filter(s => s.id !== sessionId));
    saved.current?.();
  }, []);
  const modelProposal = useRef<string | null>(null);
  const accept = useCallback((value: StudioSession): void => {
    if (id.current !== value.id) return;
    if (terminal.current === value.id && value.phase.kind !== "ended") return;
    if (value.phase.kind === "ended") terminal.current = value.id;
    setSession(value);
    const proposal = value.turns.at(-1)?.answer?.proposal;
    if (proposal) { const previous = modelProposal.current; modelProposal.current = proposal; setReword(current => !current || current === previous ? proposal : current); }
  }, []);
  const load = useCallback(async (sessionId: string): Promise<void> => {
    const owner = id.current;
    try {
      const reply = await post({ action: "read", id: sessionId });
      if (id.current !== owner && id.current !== sessionId) return;
      if (reply.ok && reply.session) {
        const local = remembered();
        const current = latest.current.session?.id === sessionId ? latest.current.draft : local?.id === sessionId ? local.draft : reply.session.draft ?? "";
        if (draftWasRecorded(reply.session, current)) clearSession(sessionId, current);
        else { setDraft(current); id.current = sessionId; accept(reply.session); }
      }
      else setError(reply.error ?? "The session could not be read.");
    } catch { setError("The saved session could not be read. Retry when Mission Control is available."); }
  }, [accept, clearSession]);
  useEffect(() => {
    if (id.current) { busy.current = true; setPending(true); void load(id.current).finally(() => { busy.current = false; setPending(false); }); }
    void post({ action: "recover", id: crypto.randomUUID() }).then(reply => setRecoverable(reply.sessions ?? [])).catch(() => setError("Saved sessions are temporarily unavailable."));
  }, [load]);
  useEffect(() => {
    if (!id.current) return;
    try { sessionStorage.setItem(ACTIVE, JSON.stringify({ id: id.current, draft, reword, turn: lastTurn.current, chosen: chosen.current })); }
    catch { setError("This browser cannot retain a draft across reloads. Save the exchange before leaving."); }
  }, [session, draft, reword, pending]);
  const start: StartDiscussion = (thread, scope) => {
    if (session || busy.current || (id.current && draft.trim())) { setError("Save the current exchange before starting another."); return; }
    const sessionId = crypto.randomUUID(); id.current = sessionId;
    terminal.current = null;
    setDraft(""); setReword(""); lastTurn.current = null; chosen.current = null; setEndingChoice(null); modelProposal.current = null; setPending(true); busy.current = true;
    try { sessionStorage.setItem(ACTIVE, JSON.stringify({ id: sessionId, draft: "", reword: "" })); } catch { setError("Draft recovery is unavailable in this browser."); }
    void post({ action: "start", id: sessionId, thread, scope }).then(reply => {
      if (reply.session) accept(reply.session);
      if (!reply.ok) setError(reply.error ?? "The session could not start."); else setError(null);
    }).catch(() => setError("Mission Control did not answer. Use Resume saved exchange to retry."))
      .finally(() => { setPending(false); busy.current = false; });
  };
  const send = async (): Promise<void> => {
    if (!session || busy.current) return;
    busy.current = true; setPending(true); setError(null);
    const unanswered = session.turns.find(t => !t.answer);
    const text = unanswered?.text ?? lastTurn.current?.text ?? draft.trim();
    if (!text) { busy.current = false; setPending(false); return; }
    const turn = unanswered?.id ?? lastTurn.current?.id ?? crypto.randomUUID();
    lastTurn.current = { id: turn, text };
    try {
      const reply = await post({ action: "say", id: session.id, turn, text, draft: draft.trim() });
      if (id.current !== session.id) return;
      if (reply.session) accept(reply.session);
      if (reply.ok && reply.session) { lastTurn.current = null; setDraft(current => current.trim() === text ? "" : current); }
      else setError(reply.error ?? "Your text is retained. Retry or save the exchange.");
    } catch { if (id.current !== session.id) return; setError("Mission Control did not answer. Your draft is retained; reload the saved exchange before retrying."); await load(session.id); }
    finally { if (!ending.current && (!id.current || id.current === session.id)) { busy.current = false; setPending(false); } }
  };
  const end = useCallback(async (outcome: SessionEnd = { kind: "leave" }): Promise<void> => {
    const state = latest.current;
    if (!state.session || ending.current) return;
    if (state.session.phase.kind === "ended") {
      if (draftWasRecorded(state.session, state.draft)) clearSession(state.session.id, state.draft);
      else setError("This exchange is already saved. Save the remaining message or copy it before closing.");
      return;
    }
    ending.current = true; busy.current = true; chosen.current ??= state.session.phase.kind === "ending" ? state.session.phase.outcome : outcome; const selected = chosen.current; setEndingChoice(selected); setPending(true); setError(null);
    try {
      const reply = await post({ action: "end", id: state.session.id, outcome: selected, draft: state.draft.trim() });
      if (reply.session) accept(reply.session);
      if (reply.ok && reply.session?.phase.kind === "ended") {
        if (draftWasRecorded(reply.session, latest.current.draft)) clearSession(state.session.id, latest.current.draft);
        else { chosen.current = null; setEndingChoice(null); setError("The earlier exchange is saved. Your remaining message still needs saving or copying."); }
      } else { if (reply.session?.phase.kind === "open") { chosen.current = null; setEndingChoice(null); } setError(reply.error ?? "The exchange is retained. Retry saving it."); }
    } catch { setError("The exchange is retained. Mission Control did not confirm its note; retry saving it."); await load(state.session.id); }
    finally { ending.current = false; busy.current = false; setPending(false); }
  }, [accept, load, clearSession]);
  const saveRemaining = async (): Promise<void> => {
    const state = latest.current;
    if (!state.session || state.session.phase.kind !== "ended" || draftWasRecorded(state.session, state.draft) || busy.current) return;
    const text = state.draft.trim();
    busy.current = true; setPending(true); setError(null);
    try {
      const reply = await post({ action: "save-message", id: state.session.id, text });
      if (reply.ok && reply.commit && id.current === state.session.id && latest.current.draft.trim() === text) clearSession(state.session.id, latest.current.draft);
      else setError(reply.error ?? "Your remaining message is still here. Retry saving it, or copy it.");
    } catch { setError("Your remaining message is still here. Retry saving it, or copy it."); }
    finally { busy.current = false; setPending(false); }
  };
  const copyRemaining = async (): Promise<void> => {
    const state = latest.current;
    if (!state.session || state.session.phase.kind !== "ended" || busy.current) return;
    try {
      await navigator.clipboard.writeText(state.draft);
      if (id.current === state.session.id && latest.current.draft === state.draft) clearSession(state.session.id, state.draft);
    } catch { setError("Copy did not succeed. Your message is still selected here; copy it before leaving."); }
  };
  useEffect(() => {
    const leaving = (): void => {
      const state = latest.current;
      if (!state.session || state.session.phase.kind === "ended") return;
      void post({ action: "end", id: state.session.id, outcome: chosen.current ?? (state.session.phase.kind === "ending" ? state.session.phase.outcome : { kind: "leave" }), draft: state.draft.trim() }).catch(() => { sessionStorage.setItem(ACTIVE, JSON.stringify({ id: state.session?.id, draft: state.draft, reword: state.reword, turn: lastTurn.current, chosen: chosen.current })); });
    };
    window.addEventListener("pagehide", leaving);
    return () => window.removeEventListener("pagehide", leaving);
  }, []);
  return { session, recoverable, remaining: session?.phase.kind === "ended" && !draftWasRecorded(session, draft), chosen: endingChoice, retrying: Boolean(lastTurn.current), resumeId: id.current, draft, setDraft, reword, setReword, pending, error, start, send, end, load, saveRemaining, copyRemaining };
}
export type StudioSessionControls = ReturnType<typeof useStudioSession>;

export function StudioSessionPanel({ controls: c, voice, location }: { controls: StudioSessionControls; voice: DeskVoice; location: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const previousLocation = useRef(location);
  useEffect(() => {
    if (previousLocation.current !== location) { previousLocation.current = location; void c.end(); }
  }, [location, c.end]);
  const mic = useDeskVoice({ ...voice, enabled: voice.enabled && c.session?.phase.kind === "open" && !c.pending }, {
    answer: async said => { c.setDraft(current => current ? `${current}\n${said}` : said); input.current?.focus(); return "Added to your message."; },
    briefing: () => "", isBriefing: () => false, typeInstead: () => input.current?.focus(),
  });
  useEffect(() => { if (c.session?.phase.kind !== "open" || c.chosen) mic.dismiss(); }, [c.session?.id, c.session?.phase.kind, c.chosen, mic.dismiss]);
  if (!c.session) return c.recoverable.length || c.error ? <aside className="dst-session-recovery">
    {c.error && <p role="alert">{c.error}</p>}
    {c.resumeId && !c.recoverable.some(s => s.id === c.resumeId) && <button type="button" className="desk-btn" onClick={() => c.resumeId && void c.load(c.resumeId)}>Resume saved exchange</button>}
    {c.recoverable.map(s => <button type="button" className="desk-btn" key={s.id} onClick={() => void c.load(s.id)}>Resume saved exchange on {s.thread}</button>)}
  </aside> : null;
  const session = c.session;
  const ghost = session.scope.kind === "ghost";
  if (c.remaining) return <aside className="dst-session" role="dialog" aria-label={ghost ? "Discuss with Ivy" : "Talk it through with Ivy"}>
    <header><h2>Your message is still here</h2></header>
    <p>The exchange was already saved. This remaining message has not been saved. Save it to the thread or copy it before closing.</p>
    <label>Your remaining message<textarea ref={input} aria-label="Your remaining message" readOnly value={c.draft} /></label>
    {c.error && <p className="desk-unsent" role="alert">{c.error}</p>}
    <div className="dst-acts">
      <button type="button" className="desk-btn pri" disabled={c.pending} onClick={() => void c.saveRemaining()}>Save remaining message</button>
      <button type="button" className="desk-btn" disabled={c.pending} onClick={() => { input.current?.select(); void c.copyRemaining(); }}>Copy message and close</button>
    </div>
  </aside>;
  const ending = c.chosen ?? (session.phase.kind !== "open" ? session.phase.outcome : null);
  return <aside className="dst-session" role="dialog" aria-label={ghost ? "Discuss with Ivy" : "Talk it through with Ivy"}>
    <header><h2>{ghost ? "Discuss" : "Talk it through"}</h2><button type="button" className="desk-btn ghost" onClick={() => void c.end(ending ?? { kind: "leave" })}>Close and save note</button></header>
    <p>{session.original}</p><p className="dst-session-policy">{session.policy === "local" ? "Local model" : "Thread's allowed model"} · Ivy can only read this context and propose changes.</p>
    <div className="dst-session-exchange" aria-live="polite">{session.turns.map(t => <div key={t.id}><p><b>You:</b> {t.text}</p><p><b>Ivy:</b> {t.answer?.reply ?? "Your text is saved. No answer received yet."}</p></div>)}</div>
    <form onSubmit={e => { e.preventDefault(); void c.send(); }}>
      <label>Your message<textarea aria-label="Your message" readOnly={Boolean(c.chosen) || session.phase.kind !== "open"} ref={input} value={c.draft} maxLength={4000} onChange={e => c.setDraft(e.target.value)} /></label>
      <div className="dst-acts">{mic.available && <MicButton phase={mic.state.phase} onStart={mic.start} onStop={mic.stop} />}<button className="desk-btn pri" disabled={c.pending || (!c.draft.trim() && !c.retrying && !session.turns.some(t => !t.answer))}>{c.retrying || session.turns.some(t => !t.answer) ? "Retry saved turn" : "Send"}</button></div>
      {mic.state.fallback && <p role="status">{mic.state.fallback}</p>}
    </form>
    {(c.retrying || session.turns.some(t => !t.answer)) && <p className="dst-session-policy">Retry saved turn sends the original saved text. Any edited draft stays here for your next message, or you can close and save both.</p>}
    {c.error && <p className="desk-unsent" role="alert">{c.error}</p>}
    <label>{ghost ? "Reworded idea or stand" : "Optional proposed stand"}<textarea aria-label={ghost ? "Reworded idea or stand" : "Optional proposed stand"} readOnly={Boolean(c.chosen) || session.phase.kind !== "open"} value={c.reword} maxLength={4000} onChange={e => c.setReword(e.target.value)} /></label>
    <div className="dst-acts">
      {ending ? <button className="desk-btn pri" disabled={c.pending} onClick={() => void c.end(ending)}>Retry saving chosen outcome</button> : ghost ? <>
        <button className="desk-btn" disabled={c.pending} onClick={() => void c.end({ kind: "keep" })}>Keep as is</button>
        <button className="desk-btn pri" disabled={c.pending || !c.reword.trim()} onClick={() => void c.end({ kind: "reword", text: c.reword.trim() })}>Keep reworded</button>
        <button className="desk-btn ghost" disabled={c.pending} onClick={() => void c.end({ kind: "dismiss" })}>Dismiss</button>
      </> : <>
        <button className="desk-btn" disabled={c.pending} onClick={() => void c.end()}>End and save summary</button>
        <button className="desk-btn pri" disabled={c.pending || !c.reword.trim()} onClick={() => void c.end({ kind: "propose", text: c.reword.trim() })}>Save summary and propose stand</button>
      </>}
    </div><p className="dst-session-policy">Closing saves this exchange and any unsent message as a note. Your current stand changes only when you explicitly keep a proposed stand.</p>
  </aside>;
}
