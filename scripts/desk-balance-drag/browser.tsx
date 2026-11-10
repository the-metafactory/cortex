import { createRoot } from "react-dom/client";
import { Profiler } from "react";
import { DeskBalance } from "../../src/surface/mc/dashboard-v2/components/desk-balance";
import type { DeskView } from "../../src/surface/mc/desk/types";

const view = await (await fetch("/api/desk")).json() as DeskView;
const root = document.getElementById("root");
if (!root || !view.myDay) throw new Error("Balance drag fixture unavailable.");
let commits = 0;
createRoot(root).render(<Profiler id="balance" onRender={() => { document.body.dataset.balanceCommits = String(++commits); }}><DeskBalance day={view.myDay} view={view} foreground={{ kind: "unavailable", reason: "Browser probe" }} onChanged={() => undefined} onThread={() => undefined} /></Profiler>);
