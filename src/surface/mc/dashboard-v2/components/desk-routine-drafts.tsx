import type { BuildState, DraftNodeView, RoutineDraftView } from "../../desk/routine-capability-contract";

const prLabel = (pr: string): string => (/^\d+$/.test(pr) ? `PR #${pr}` : pr);

export function buildStateText(build: BuildState | null): string {
  if (!build) return "";
  switch (build.state) {
    case "filed": return "Filed, waiting to start";
    case "building": return "Building";
    case "in-review": return "In review";
    case "merged": return "Merged";
    case "live": return "Live";
    case "failed": return `Failed: ${build.reason ?? "no reason was reported"}`;
    case "unknown": return `State unknown: ${build.error}`;
  }
}

export function BuildStateLine({ node }: { node: DraftNodeView }) {
  const { build } = node;
  const pr = build && build.state !== "unknown" ? build.pr : undefined;
  return <p role={build?.state === "failed" || build?.state === "unknown" ? "alert" : "status"}>
    <strong>{node.capability}</strong>
    {build && <>: {buildStateText(build)}</>}
    {pr && <> ({prLabel(pr)})</>}
    {node.notStarted && <> · Not started: {node.notStarted}</>}
    {" "}<a href={node.url} target="_blank" rel="noreferrer">{node.ref}</a>
  </p>;
}

export function RoutineDrafts({ drafts }: { drafts: RoutineDraftView[] | undefined }) {
  if (!drafts?.length) return null;
  return <section aria-label="Routine drafts waiting for a capability">
    <h4>Drafts waiting for a capability</h4>
    <ul className="desk-sub">
      {drafts.map((draft) => <li key={draft.proposalId}><div>
        {draft.title}
        {draft.nodes.map((node) => <BuildStateLine key={node.capability} node={node} />)}
      </div></li>)}
    </ul>
  </section>;
}
