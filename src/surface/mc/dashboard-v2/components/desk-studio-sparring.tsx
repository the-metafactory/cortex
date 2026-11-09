import type { ThreadPage } from "../../desk/studio/page";
import type { StudioActs } from "../hooks/use-studio-act";

const MODES = [
  { mode: "think", label: "Think now" },
  { mode: "grill", label: "Grill me" },
  { mode: "other-side", label: "Argue the other side" },
  { mode: "red-team", label: "Red team" },
  { mode: "first-principles", label: "First principles" },
];

const BLOCKED = {
  open: () => null,
  spent: (policy: string) => `Today's ${policy} thinking budget is spent. Queued requests wait until tomorrow (UTC).`,
  off: (policy: string) => `${policy[0]?.toUpperCase()}${policy.slice(1)} thinking is turned off: its daily run limit in Ranger is 0.`,
} as const;

const BUTTON_SUFFIX = { spent: "budget spent", off: "turned off" } as const;

export function Sparring({ page, acts }: { page: ThreadPage; acts?: StudioActs }) {
  if (page.thread.state === "closed") return null;
  const thinking = page.thinking;
  const budget = thinking.kind === "ready" ? thinking.budget : "open";
  const blocked = thinking.kind === "unavailable" ? thinking.reason : BLOCKED[budget](page.policy);
  const modes = [...MODES, ...page.personas.map(name => ({ mode: `persona:${name}`, label: `What would ${name} say?` }))];
  return (
    <section className="dst-sparring" aria-label="Think with Ivy">
      <h4 className="dst-h">Think with Ivy <span className="n">lands as a note</span></h4>
      {blocked && <p className="dst-none" role="status">{blocked}</p>}
      <div className="dst-acts">
        {modes.map(({ mode, label }) => <button key={mode} type="button" className="desk-btn ghost" disabled={!acts || acts.pending || blocked !== null} title={blocked ?? undefined} onClick={() => void acts?.send({ act: "spar", thread: page.thread.slug, mode })}>{budget === "open" ? label : `${label} · ${BUTTON_SUFFIX[budget]}`}</button>)}
      </div>
      {thinking.kind === "ready" && thinking.runs.map(run => <p key={run.id} className="dst-waits" role="status">{run.status === "failed" ? "Thinking failed" : "Pending"}: {run.mode.replaceAll("-", " ")}. {run.reason}</p>)}
    </section>
  );
}
