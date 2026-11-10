import { createRoot } from "react-dom/client";
import { ConnectionSetup } from "../../src/surface/mc/dashboard-v2/components/desk-connection-setup";
const root = document.getElementById("root");
if (!root) throw new Error("Balance connection probe root missing.");
createRoot(root).render(<ConnectionSetup />);
