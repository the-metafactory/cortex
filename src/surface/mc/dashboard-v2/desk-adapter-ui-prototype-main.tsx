import { createRoot } from "react-dom/client";
import { DeskView } from "./components/desk-view";
import "./styles/tokens.css";
import "./styles/global.css";
const root = document.getElementById("root");
if (!root) throw new Error("Prototype root is missing.");
createRoot(root).render(<DeskView onOpenMissionControl={() => { location.search = "?desk=adapter-ui-prototype&variant=A"; }} />);
