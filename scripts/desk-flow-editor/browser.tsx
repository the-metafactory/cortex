import { createRoot } from "react-dom/client";
import { DeskAdapterFrame } from "../../src/surface/mc/dashboard-v2/components/desk-adapter-frame";

const config = await fetch("/fixture.json", { redirect: "error", cache: "no-store" }).then(response => response.json()) as { mountId: string };
createRoot(document.getElementById("root")!).render(<DeskAdapterFrame mountId={config.mountId} fallback={<article><h2>Flow draft</h2><p>Safe host rendering of the Flow draft remains available.</p></article>} />);
