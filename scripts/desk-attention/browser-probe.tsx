import { createRoot } from "react-dom/client";
import { useDesk } from "../../src/surface/mc/dashboard-v2/hooks/use-desk";
import { DeskBody } from "../../src/surface/mc/dashboard-v2/components/desk-view";

function Probe() {
  const { view, error, reload } = useDesk(true);
  return <><button type="button" onClick={reload}>Refresh probe</button>{view && <DeskBody view={view} error={error} onOpenMissionControl={() => undefined} onChanged={reload} />}</>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Probe root missing.");
createRoot(root).render(<Probe />);
