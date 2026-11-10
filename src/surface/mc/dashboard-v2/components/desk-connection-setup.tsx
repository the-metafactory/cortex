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
const sameRef = (a: object, b: object): boolean => JSON.stringify(a) === JSON.stringify(b);
type Ref = PackageForm["destinations"][number]["ref"];

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
      <span>{label}<small>{STATE_TEXT[connection.state]}{connection.reason ? ` · ${REASON_TEXT[connection.reason] ?? "See setup."}` : ""}</small></span>
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
      <div role="group" aria-label="Read access">
        {form.capabilities.filter(item => item.access === "read").map(item => (
          <label key={item.capabilityId}><input type="checkbox" checked={reads.includes(item.capabilityId)} onChange={event => setReads(toggle(reads, item.capabilityId, event.target.checked, (a, b) => a === b))} />Read: {item.label}</label>
        ))}
        {form.destinations.map(item => (
          <label key={`r-${item.ref.canonicalId}`}><input type="checkbox" checked={readDestinations.some(ref => sameRef(ref, item.ref))} onChange={event => setReadDestinations(toggle(readDestinations, item.ref, event.target.checked, sameRef))} />Read from: {item.label}</label>
        ))}
      </div>
      <div role="group" aria-label="Write access">
        {form.capabilities.filter(item => item.access === "write").map(item => (
          <label key={item.capabilityId}><input type="checkbox" checked={writes.includes(item.capabilityId)} onChange={event => setWrites(toggle(writes, item.capabilityId, event.target.checked, (a, b) => a === b))} />Write: {item.label}</label>
        ))}
        {form.destinations.map(item => (
          <label key={`w-${item.ref.canonicalId}`}><input type="checkbox" checked={writeDestinations.some(ref => sameRef(ref, item.ref))} onChange={event => setWriteDestinations(toggle(writeDestinations, item.ref, event.target.checked, sameRef))} />Write to: {item.label}</label>
        ))}
      </div>
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
