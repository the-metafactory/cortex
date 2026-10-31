import type { ThreadPage } from "../../desk/studio/page";
import type { StudioActs } from "../hooks/use-studio-act";

const MODES = [
  { mode: "think", label: "Think now" },
  { mode: "grill", label: "Grill me" },
  { mode: "other-side", label: "Argue the other side" },
  { mode: "red-team", label: "Red team" },
  { mode: "first-principles", label: "First principles" },
];

export function Sparring({ page, acts }: { page: ThreadPage; acts?: StudioActs }) {
  if (page.thread.state === "closed") return null;
  const thinking = page.thinking;
  const blocked = thinking.kind === "unavailable" ? thinking.reason : thinking.budgetSpent ? `Today's ${page.policy} thinking budget is spent. Queued requests wait until tomorrow (UTC).` : null;
  const modes = [...MODES, ...page.personas.map(name => ({ mode: `persona:${name}`, label: `What would ${name} say?` }))];
  return (
    <section className="dst-sparring" aria-label="Think with Ivy">
      <h4 className="dst-h">Think with Ivy <span className="n">lands as a note</span></h4>
      {blocked && <p className="dst-none" role="status">{blocked}</p>}
      <div className="dst-acts">
        {modes.map(({ mode, label }) => <button key={mode} type="button" className="desk-btn ghost" disabled={!acts || acts.pending || blocked !== null} title={blocked ?? undefined} onClick={() => void acts?.send({ act: "spar", thread: page.thread.slug, mode })}>{thinking.kind === "ready" && thinking.budgetSpent ? `${label} · budget spent` : label}</button>)}
      </div>
      {thinking.kind === "ready" && thinking.runs.map(run => <p key={run.id} className="dst-waits" role="status">{run.status === "failed" ? "Thinking failed" : "Pending"}: {run.mode.replaceAll("-", " ")}. {run.reason}</p>)}
    </section>
  );
}
