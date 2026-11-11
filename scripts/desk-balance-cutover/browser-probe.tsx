import { createRoot } from "react-dom/client";
import { CreationPanel } from "../../src/surface/mc/dashboard-v2/components/desk-conversation-create";

const fixture = await (await fetch("/fixture.json")).json() as { conversationId: string };
const mount = document.getElementById("root");
if (!mount) throw new Error("probe root missing");
createRoot(mount).render(<CreationPanel id={fixture.conversationId} archived={false} revision={0} seed={{ entryId: null, text: "" }} />);
document.body.dataset.mounted = "true";
