import { createRoot } from "react-dom/client";
import { DeskRoutineEditor } from "../../src/surface/mc/dashboard-v2/components/desk-routine-editor";
import { defaultRoutinesLocation } from "../../src/surface/mc/dashboard-v2/hooks/use-routines-location";

const mount = document.getElementById("root");
if (!mount) throw new Error("probe root missing");
createRoot(mount).render(<DeskRoutineEditor onBack={() => undefined} location={{ ...defaultRoutinesLocation(), tab: "flows" }} />);
document.body.dataset.mounted = "true";
