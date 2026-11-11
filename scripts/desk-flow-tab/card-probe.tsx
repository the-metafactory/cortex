import { createRoot } from "react-dom/client";
import type { Capability, CreationView } from "../../src/conversations/creation";
import { CreationSection } from "../../src/surface/mc/dashboard-v2/components/desk-conversation-create";

const fixture = await (await fetch("/card-fixture.json")).json() as { types: Capability[]; view: CreationView };
const mount = document.getElementById("root");
if (!mount) throw new Error("probe root missing");
createRoot(mount).render(<CreationSection id="probe-conversation" archived={false} types={fixture.types} view={fixture.view} error={null} busy={false} seed={{ entryId: null, text: "" }} act={() => Promise.resolve()} />);
document.body.dataset.mounted = "true";
