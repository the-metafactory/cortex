import { useEffect, useState } from "react";
import { disableConnection, enableConnection, requestSetup, retryConnection, saveConnection, type ConnectionView, type PackageForm, type SetupOutcome, type SetupSnapshot, type SlotChoice } from "../lib/desk-connection-setup";

const STATE_TEXT: Record<ConnectionView["state"], string> = {
  discovered: "Discovered, not set up",
  incomplete: "Setup incomplete",
  disabled: "Set up, disabled",
  enabled: "Enabled",
  unavailable: "Unavailable",
};
const REASON_TEXT: Record<string, string> = {
  store_unavailable: "The credential store is not available. Retry once it is back.",
  store_write_failed: "The credential could not be stored. Retry.",
  missing_input: "A credential is still missing.",
  commit_failed: "The connection could not be recorded. Retry.",
  oauth_broker_unavailable: "Sign-in through a provider is not available on this stack.",
  auth_kind_unavailable: "This sign-in method is not supported on this stack.",
  reference_missing: "The selected environment reference is not set.",
  package_missing: "The package is not installed. Your saved setup is kept.",
};
const STATUS_TEXT: Record<ConnectionView["status"]["state"], string> = {
  available: "Available",
  unavailable: "Unavailable",
  stale: "Stale",
  fenced: "Fenced",
};
const STATUS_REASON_TEXT: Record<string, string> = {
  not_reported: "No adapter activity has been reported yet.",
  not_configured: "The connection is not set up yet.",
  disabled: "The connection is disabled. Enable it to use it.",
  setup_incomplete: "The credential setup is incomplete.",
  reconfigured: "The scope changed. Enable the connection again.",
  package_missing: "The package is not installed. Your saved setup is kept.",
  binding_fenced: "A safety trigger fenced this binding. Reads continue; mutation stays off.",
  last_success_too_old: "No successful use was recorded recently. Check the connection.",
  refused: "The adapter refused the last query.",
};
const when = (value: string | null): string => value === null ? "never" : new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC");
const statusLine = (connection: ConnectionView): string => {
  const reason = connection.status.reason;
  return `${STATUS_TEXT[connection.status.state]} · last success ${when(connection.status.lastSuccessAt)} · last attempt ${when(connection.status.lastAttemptAt)}${reason ? ` · ${STATUS_REASON_TEXT[reason] ?? "A safety check stopped adapter use. See diagnostics."}` : ""}`;
};
const sameRef = (a: object, b: object): boolean => JSON.stringify(a) === JSON.stringify(b);
type Ref = PackageForm["destinations"][number]["ref"];

type ObjectReference = PackageForm["destinations"][number]["ref"];

function toggle<T>(list: T[], item: T, on: boolean, same: (a: T, b: T) => boolean): T[] {
  const rest = list.filter(entry => !same(entry, item));
  return on ? [...rest, item] : rest;
}

export function ConnectionSetup({ active = true, load = requestSetup }: { active?: boolean; load?: () => Promise<SetupSnapshot> }) {
  const [snapshot, setSnapshot] = useState<SetupSnapshot | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async (): Promise<void> => { setSnapshot(await load()); };
  useEffect(() => { if (active) void refresh(); }, [active]);
  const apply = async (run: () => Promise<SetupOutcome>): Promise<void> => {
    setBusy(true);
    const outcome = await run();
    setNote(outcome.ok ? null : outcome.error);
    await refresh();
    setBusy(false);
  };
  return <ConnectionSetupBody snapshot={snapshot} note={note} busy={busy} apply={apply} />;
}

export function ConnectionSetupBody({ snapshot, note, busy, apply }: { snapshot: SetupSnapshot | null; note: string | null; busy: boolean; apply: (run: () => Promise<SetupOutcome>) => Promise<void> }) {
  if (!snapshot) return <section className="desk-set-card" aria-label="Connections"><h2>Connections</h2><p role="status">Loading connections.</p></section>;
  if (!snapshot.ok) return <section className="desk-set-card" aria-label="Connections"><h2>Connections</h2><p className="desk-set-err" role="alert">{snapshot.error}</p></section>;
  const labelOf = (id: string): string => snapshot.packages.find(item => item.packageId === id)?.label ?? id;
  return (
    <section className="desk-set-card" aria-label="Connections">
      <h2>Connections</h2>
      <p className="desk-set-sub">Installing a package enables nothing. Set up a connection, then enable it yourself. Only this stack's principal can do this.</p>
      {note && <p className="desk-set-err" role="alert">{note}</p>}
      {snapshot.connections.length > 0 && <ul className="desk-set-list">
        {snapshot.connections.map(connection => <ConnectionRow key={connection.connectionId} connection={connection} label={labelOf(connection.packageId)} form={snapshot.packages.find(item => item.packageId === connection.packageId)} busy={busy} apply={apply} />)}
      </ul>}
      {snapshot.packages.map(form => <PackageSetup key={form.packageId} form={form} busy={busy} apply={apply} />)}
      {snapshot.packages.length === 0 && <p className="desk-set-empty">No packages are registered on this stack.</p>}
    </section>
  );
}

function ConnectionRow({ connection, label, form, busy, apply }: { connection: ConnectionView; label: string; form: PackageForm | undefined; busy: boolean; apply: (run: () => Promise<SetupOutcome>) => Promise<void> }) {
  const [entries, setEntries] = useState<Record<string, string>>({});
  const missing = connection.slots.filter(slot => slot.presence === "missing");
  const retry = (): void => {
    const inputs: Record<string, SlotChoice> = {};
    for (const slot of missing) { const value = entries[slot.slot]; if (value) inputs[slot.slot] = { token: value }; }
    void apply(() => retryConnection(connection.connectionId, connection.revision, inputs)).then(() => setEntries({}));
  };
  return (
    <li aria-label={`${label} connection`}>
      <span>{label}<small>{STATE_TEXT[connection.state]}{connection.reason ? ` · ${REASON_TEXT[connection.reason] ?? "See setup."}` : ""}</small><small className="desk-set-status">{statusLine(connection)}</small></span>
      {connection.state === "incomplete" && form && missing.map(slot => (
        <label key={slot.slot}>{slot.slot}
          <input type="password" autoComplete="off" spellCheck={false} aria-label={`Credential for ${slot.slot}`} value={entries[slot.slot] ?? ""} onChange={event => setEntries({ ...entries, [slot.slot]: event.target.value })} />
        </label>
      ))}
      {connection.state === "incomplete" && <button type="button" disabled={busy} onClick={retry}>Retry setup</button>}
      {connection.state === "disabled" && <button type="button" disabled={busy} onClick={() => void apply(() => enableConnection(connection.connectionId, connection.revision))}>Enable</button>}
      {connection.state === "enabled" && <button type="button" disabled={busy} onClick={() => void apply(() => disableConnection(connection.connectionId, connection.revision))}>Disable</button>}
    </li>
  );
}

interface AccessSelectionProps {
  mode: "read" | "write";
  form: PackageForm;
  capabilities: string[];
  destinations: ObjectReference[];
  onCapabilities(next: string[]): void;
  onDestinations(next: ObjectReference[]): void;
}

function AccessSelection({ mode, form, capabilities, destinations, onCapabilities, onDestinations }: AccessSelectionProps) {
  const noun = mode === "read" ? "Read" : "Write";
  const preposition = mode === "read" ? "from" : "to";
  return (
    <div role="group" aria-label={`${noun} access`}>
      {form.capabilities.filter(item => item.access === mode).map(item => (
        <label key={item.capabilityId}><input type="checkbox" checked={capabilities.includes(item.capabilityId)} onChange={event => onCapabilities(toggle(capabilities, item.capabilityId, event.target.checked, (a, b) => a === b))} />{noun}: {item.label}</label>
      ))}
      {form.destinations.map(item => (
        <label key={`${mode}-${item.ref.canonicalId}`}><input type="checkbox" checked={destinations.some(ref => sameRef(ref, item.ref))} onChange={event => onDestinations(toggle(destinations, item.ref, event.target.checked, sameRef))} />{noun} {preposition}: {item.label}</label>
      ))}
    </div>
  );
}

function PackageSetup({ form, busy, apply }: { form: PackageForm; busy: boolean; apply: (run: () => Promise<SetupOutcome>) => Promise<void> }) {
  const [scope, setScope] = useState<Record<string, string>>({});
  const [reads, setReads] = useState<string[]>([]);
  const [writes, setWrites] = useState<string[]>([]);
  const [readDestinations, setReadDestinations] = useState<Ref[]>([]);
  const [writeDestinations, setWriteDestinations] = useState<Ref[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<Record<string, string>>({});
  const complete = form.scopeFields.every(field => (scope[field.name] ?? "").trim() !== "");
  const submit = (): void => {
    const inputs: Record<string, SlotChoice> = {};
    for (const slot of form.slots) {
      const reference = references[slot.slot];
      const token = tokens[slot.slot];
      if (reference) inputs[slot.slot] = { reference };
      else if (token) inputs[slot.slot] = { token };
    }
    void apply(() => saveConnection({ packageId: form.packageId, scope, readCapabilityIds: reads, writeCapabilityIds: writes, readDestinations, writeDestinations, inputs })).then(() => { setTokens({}); });
  };
  return (
    <fieldset className="desk-set-sub" aria-label={`Set up ${form.label}`} disabled={busy}>
      <legend>{form.label}</legend>
      {form.unavailableReason && <p role="status">{REASON_TEXT[form.unavailableReason] ?? "Not available."}</p>}
      {form.scopeFields.map(field => (
        <label key={field.name}>{field.label}
          <input type="text" value={scope[field.name] ?? ""} maxLength={256} onChange={event => setScope({ ...scope, [field.name]: event.target.value })} />
        </label>
      ))}
      <AccessSelection mode="read" form={form} capabilities={reads} destinations={readDestinations} onCapabilities={setReads} onDestinations={setReadDestinations} />
      <AccessSelection mode="write" form={form} capabilities={writes} destinations={writeDestinations} onCapabilities={setWrites} onDestinations={setWriteDestinations} />
      {!form.unavailableReason && form.slots.map(slot => (
        <div key={slot.slot}>
          <label>{slot.slot} ({slot.kind})
            <input type="password" autoComplete="off" spellCheck={false} aria-label={`Credential for ${slot.slot}`} value={tokens[slot.slot] ?? ""} disabled={Boolean(references[slot.slot])} onChange={event => setTokens({ ...tokens, [slot.slot]: event.target.value })} />
          </label>
          {form.references.length > 0 && (
            <label>or use an existing environment reference
              <select aria-label={`Reference for ${slot.slot}`} value={references[slot.slot] ?? ""} onChange={event => setReferences({ ...references, [slot.slot]: event.target.value })}>
                <option value="">None</option>
                {form.references.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          )}
        </div>
      ))}
      <button type="button" disabled={busy || !complete || Boolean(form.unavailableReason)} onClick={submit}>Save setup</button>
    </fieldset>
  );
}
