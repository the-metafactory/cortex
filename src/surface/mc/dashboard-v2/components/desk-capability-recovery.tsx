import { useState } from "react";
import type { CapabilityInstallView } from "../../desk/routine-capability-contract";
import { submitCapabilityInstall } from "../lib/desk-capability-install";

function CheckPack({ install, onChanged }: { install: CapabilityInstallView; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (outcome: "installed" | "absent"): Promise<void> => {
    if (busy || (install.state !== "running" && install.state !== "undoing")) return;
    setBusy(true); setError(null);
    try {
      const result = await submitCapabilityInstall({ action: "capability.resolve", id: install.id, state: install.state, at: install.at, outcome });
      if (!result.ok) { setError(result.error); return; }
      setConfirm(false); onChanged();
    } catch (error) { setError(error instanceof Error ? error.message : "The pack check did not answer. Refresh and check again."); }
    finally { setBusy(false); }
  };
  return <div>
    <p role="status">{install.pack}: {install.state === "undoing" ? "Uninstall" : "Install"} outcome unconfirmed{install.error ? `: ${install.error}` : "."}</p>
    {confirm ? <>
      <p>Check that the pack command has stopped. Confirm whether {install.pack} is installed and its agents have reloaded, or the pack is absent. This records the outcome and allows further pack changes.</p>
      <button className="desk-btn" type="button" disabled={busy} onClick={() => { void resolve("installed"); }}>Confirm installed</button>
      <button className="desk-btn" type="button" disabled={busy} onClick={() => { void resolve("absent"); }}>Confirm absent</button>
      <button className="desk-btn" type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
    </> : <button className="desk-btn" type="button" onClick={() => setConfirm(true)}>Check pack</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function CapabilityRecovery({ installs, onChanged }: { installs: CapabilityInstallView[] | undefined; onChanged: () => void }) {
  if (!installs?.length) return null;
  return <section aria-label="Unconfirmed capability packs">{installs.map((install) => <CheckPack key={`${install.id}:${install.state}:${install.at}`} install={install} onChanged={onChanged} />)}</section>;
}
