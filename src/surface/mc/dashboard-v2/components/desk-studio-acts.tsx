import { useState } from "react";
import type { BoardArea } from "../../desk/studio/board";
import { clip } from "../../desk/studio/board";
import type { ThreadOutcome } from "../../desk/studio/format";
import { YES_ANSWERS } from "../../desk/studio/labels";
import type { StudioView } from "../../desk/studio/view";
import type { StudioActs } from "../hooks/use-studio-act";

export type OpenRequest =
  | { kind: "open"; from: "proposal" | "capture"; id: string; question: string; area: string | null; reason: string | null }
  | { kind: "unpark"; slug: string; question: string };

const ANSWER_LABEL: Record<(typeof YES_ANSWERS)[number], string> = { yes: "Yes", "not sure": "Not sure", no: "No" };
const OUTCOMES: { id: ThreadOutcome; label: string; ask: string }[] = [
  { id: "decided", label: "Decided", ask: "What did you decide?" },
  { id: "shipped", label: "Shipped", ask: "What did you ship?" },
  { id: "dropped", label: "Dropped", ask: "Why drop it?" },
];

const areaLabel = (areas: readonly BoardArea[], id: string): string => areas.find((a) => a.id === id)?.label ?? id;

function ParkPicker({ studio, park, onPark }: { studio: StudioView; park: string | null; onPark: (slug: string) => void }) {
  return (
    <>
      <h5>All {studio.maxActive} places are in use</h5>
      <p className="dst-capwarn">
        <b>Choose a thread to park.</b> It goes to the shelf with its notes, and its place goes to this one.
      </p>
      <div className="dst-pick" role="radiogroup" aria-label="Thread to park">
        {studio.active.map((t) => (
          <button key={t.slug} type="button" role="radio" aria-checked={park === t.slug} onClick={() => onPark(t.slug)}>
            {clip(t.question, 70)}
          </button>
        ))}
      </div>
    </>
  );
}

export function YesFilter({ studio, answers, onAnswer, parking }: { studio: StudioView; answers: Record<string, string>; onAnswer: (q: string, a: string) => void; parking: string | null }) {
  const f = studio.yesFilter;
  const open = f.questions.length > 1 ? f.questions.at(-1) : undefined;
  const toggles = open === undefined ? f.questions : f.questions.slice(0, -1);
  const full = studio.active.length >= studio.maxActive;
  return (
    <>
      <h5>The Yes-filter</h5>
      <div className="dst-yes">
        {toggles.map((q) => (
          <div key={q} className="dst-yesrow">
            <span>{q}</span>
            <span className="tg" role="group" aria-label={q}>
              {YES_ANSWERS.map((a) => (
                <button key={a} type="button" aria-pressed={answers[q] === a} onClick={() => onAnswer(q, a)}>{ANSWER_LABEL[a]}</button>
              ))}
            </span>
          </div>
        ))}
        {open !== undefined && (
          <label className="dst-yesrow open">
            <span>{open}</span>
            {full
              ? <span className="dst-cfg">{parking ? `The thread you park below: “${clip(parking, 60)}”.` : "Pick the thread to park below."}</span>
              : <input value={answers[open] ?? ""} maxLength={300} placeholder="Nothing has to fall away: there is a free place" onChange={(e) => onAnswer(open, e.target.value)} />}
          </label>
        )}
      </div>
      <p className="dst-cfg">
        {f.fromConfig
          ? <>These questions come from your settings (<code>desk.studio.yesFilter</code>), not from the app's code.</>
          : <>This is the default set. Put your own questions in <code>desk.studio.yesFilter</code> in the stack config.</>}
      </p>
    </>
  );
}

export function OpenSheet({ request, studio, acts, onDone }: { request: OpenRequest; studio: StudioView; acts: StudioActs; onDone: () => void }) {
  const initial = request.kind === "open" ? (request.area ?? studio.areas[0]?.id ?? "") : "";
  const [area, setArea] = useState(initial);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [park, setPark] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const full = studio.active.length >= studio.maxActive;
  const ready = (!full || park !== null) && (request.kind === "unpark" || area !== "");

  const confirm = async (): Promise<void> => {
    const extra = full && park ? { park } : {};
    const out = request.kind === "open"
      ? await acts.send({ act: "open", from: request.from, id: request.id, area, answers: Object.fromEntries(Object.entries(answers).filter(([, a]) => a.trim() !== "")), ...extra })
      : await acts.send({ act: "unpark", thread: request.slug, ...extra });
    if (out.ok) onDone();
    else setError(out.text);
  };

  const moved = request.kind === "open" && request.area !== null && area !== request.area;
  return (
    <div className="dst-scrim" onClick={(e) => e.target === e.currentTarget && onDone()}>
      <div className="dst-sheet" role="dialog" aria-modal="true" aria-label={request.kind === "open" ? "Open a thread" : "Bring a thread back"}>
        <h2>{request.kind === "open" ? "Open a new thread" : "Bring a thread back"}</h2>
        <p className="sub">{request.question}</p>
        {request.kind === "open" && (
          <div className="dst-placed">
            <span className="iv">Ivy:</span>
            <div>
              {area ? `Placed under ${areaLabel(studio.areas, area)}` : "Choose an area"}
              {moved ? ", where you moved it." : request.reason ? `: ${request.reason}` : "."}
              <div className="chg">
                {studio.areas.filter((a) => a.id !== area).map((a) => (
                  <button key={a.id} type="button" className="dst-chip" onClick={() => setArea(a.id)}>
                    <span className="dot" style={{ background: a.color }} />Move to {a.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {request.kind === "open" && <YesFilter studio={studio} answers={answers} parking={studio.active.find((t) => t.slug === park)?.question ?? null} onAnswer={(q, a) => setAnswers((s) => ({ ...s, [q]: a }))} />}
        {full && <ParkPicker studio={studio} park={park} onPark={setPark} />}
        {error && <p className="desk-why desk-unsent" role="alert">{error}</p>}
        <div className="dst-acts end">
          <button type="button" className="desk-btn ghost" onClick={onDone}>Cancel</button>
          <button type="button" className="desk-btn pri" disabled={!ready || acts.pending} aria-busy={acts.pending} onClick={() => void confirm()}>
            {full ? (park ? "Park it and open" : "Choose one to park first") : request.kind === "open" ? "Open the thread" : "Bring it back"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CloseForm({ slug, acts, today, onCancel }: { slug: string; acts: StudioActs; today: string; onCancel: () => void }) {
  const [outcome, setOutcome] = useState<ThreadOutcome>("decided");
  const [text, setText] = useState("");
  const [expect, setExpect] = useState("");
  const [reviewOn, setReviewOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const decided = outcome === "decided";
  const ready = text.trim() !== "" && (!decided || (expect.trim() !== "" && reviewOn !== ""));
  const ask = OUTCOMES.find((o) => o.id === outcome)?.ask ?? "";

  const confirm = async (): Promise<void> => {
    const out = await acts.send({ act: "close", thread: slug, outcome, text, ...(decided ? { expect, reviewOn } : {}) });
    if (!out.ok) setError(out.text);
  };

  return (
    <form className="dst-close" aria-label="Close with an outcome" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
      <div className="dst-row" role="radiogroup" aria-label="Outcome">
        {OUTCOMES.map((o) => (
          <button key={o.id} type="button" role="radio" className="dst-chip" aria-checked={outcome === o.id} onClick={() => setOutcome(o.id)}>{o.label}</button>
        ))}
      </div>
      <label>{ask}<textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></label>
      {decided && (
        <>
          <label>What do you expect to happen?<textarea rows={2} value={expect} placeholder="The sign you would see if the decision was right" onChange={(e) => setExpect(e.target.value)} /></label>
          <label>Review on<input type="date" min={today} value={reviewOn} onChange={(e) => setReviewOn(e.target.value)} /></label>
        </>
      )}
      {error && <p className="desk-why desk-unsent" role="alert">{error}</p>}
      <div className="dst-acts end">
        <button type="button" className="desk-btn ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="desk-btn pri" disabled={!ready || acts.pending} aria-busy={acts.pending}>Close as {outcome}</button>
      </div>
    </form>
  );
}

export function RespondBox({ slug, label, acts }: { slug: string; label: string; acts: StudioActs }) {
  const [text, setText] = useState("");
  const send = async (): Promise<void> => {
    const out = await acts.send({ act: "respond", thread: slug, text });
    if (out.ok) setText("");
  };
  return (
    <form className="dst-respond" aria-label="Respond to Ivy" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <b>{label}</b>
      <textarea rows={2} value={text} aria-label="Your answer to Ivy's latest note" placeholder="Your answer to Ivy's latest note" onChange={(e) => setText(e.target.value)} />
      <button type="submit" className="desk-btn pri" disabled={text.trim() === "" || acts.pending} aria-busy={acts.pending}>Send my response</button>
    </form>
  );
}
