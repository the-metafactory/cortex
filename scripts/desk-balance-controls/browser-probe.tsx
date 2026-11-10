import { createRoot } from "react-dom/client";
import type { DeskView } from "../../src/surface/mc/desk/types";
import { DeskBalance } from "../../src/surface/mc/dashboard-v2/components/desk-balance";
import "../../src/surface/mc/dashboard-v2/components/desk-view.css";
import "../../src/surface/mc/dashboard-v2/styles/tokens.css";
import "../../src/surface/mc/dashboard-v2/styles/global.css";

const view = await (await fetch("/fixture.json")).json() as DeskView;
const mount = document.getElementById("root");
if (!mount || !view.myDay) throw new Error("Balance probe fixture missing");
createRoot(mount).render(<div className="desk"><DeskBalance day={view.myDay} view={view} foreground={{ kind: "unavailable", reason: "Browser probe" }} onChanged={() => undefined} onThread={() => undefined} /></div>);
