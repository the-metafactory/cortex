import { createRoot } from "react-dom/client";
import { DeskMakePanel } from "../../src/surface/mc/dashboard-v2/components/desk-draft-editor";

const fixture = await (await fetch("/fixture.json")).json() as { conversationId: string; entryId: string };
const mount = document.getElementById("root");
if (!mount) throw new Error("Probe root missing.");
const route = new URLSearchParams(window.location.search);
if (route.get("desk") === "conversation") {
  const { ConversationWorkspace } = await import("../../src/surface/mc/dashboard-v2/components/desk-conversation");
  createRoot(mount).render(<ConversationWorkspace id={route.get("conversation") ?? ""} onLeave={() => { window.location.href = "/"; }} />);
} else createRoot(mount).render(<DeskMakePanel conversationId={fixture.conversationId} entryId={fixture.entryId} />);
