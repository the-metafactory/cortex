import { createRoot } from "react-dom/client";
import { DeskBalance } from "../../src/surface/mc/dashboard-v2/components/desk-balance";
import type { DeskView } from "../../src/surface/mc/desk/types";

const view = await (await fetch("/api/desk")).json() as DeskView;
const root = document.getElementById("root");
if (!root || !view.myDay) throw new Error("Balance drag fixture unavailable.");
createRoot(root).render(<DeskBalance day={view.myDay} view={view} foreground={{ kind: "unavailable", reason: "Browser probe" }} onChanged={() => undefined} onThread={() => undefined} />);
