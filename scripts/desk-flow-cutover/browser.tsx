import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Capability, CreationView } from "../../src/conversations/creation";
import { CreationSection } from "../../src/surface/mc/dashboard-v2/components/desk-conversation-create";
import "../../src/surface/mc/dashboard-v2/components/desk-conversation.css";

function Probe() {
  const [fixture, setFixture] = useState<{ id: string; types: Capability[]; view: CreationView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { setFixture(await (await fetch("/fixture")).json()); };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (fixture) document.body.dataset.mounted = "true"; }, [fixture]);
  if (!fixture) return null;
  return <CreationSection id={fixture.id} types={fixture.types} view={fixture.view} error={error} busy={busy} archived={false} seed={{ entryId: null, text: "" }} act={async (run, fallback) => {
    setBusy(true);
    try { await run(); setError(null); await load(); }
    catch (error) { setError(error instanceof Error ? error.message : fallback); }
    finally { setBusy(false); }
  }} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Probe root missing");
createRoot(root).render(<Probe />);
