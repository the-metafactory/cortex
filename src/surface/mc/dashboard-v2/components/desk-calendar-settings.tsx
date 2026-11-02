import { useEffect, useState } from "react";
import type { CalendarChange, DeskCalendar } from "../../desk/calendars";
import { calendarKey } from "../../desk/calendars";
import { requestCalendars } from "../lib/desk-calendars";

export function CalendarSettings({ initial }: { initial: DeskCalendar[] }) {
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    void requestCalendars().then((r) => {
      if (!active) return;
      if (r.ok) setRows(r.calendars);
      else setError(r.error);
      setBusy(false);
    });
    return () => { active = false; };
  }, []);
  const change = async (value: CalendarChange): Promise<void> => {
    setBusy(true);
    const result = await requestCalendars(value);
    if (result.ok) { setRows(result.calendars); setError(null); }
    else setError(result.error);
    setBusy(false);
  };
  return <CalendarSettingsBody rows={rows} error={error} busy={busy} onChange={(value) => void change(value)} />;
}

export function CalendarSettingsBody({ rows, error, busy, onChange }: {
  rows: DeskCalendar[];
  error: string | null;
  busy: boolean;
  onChange: (change: CalendarChange) => void;
}) {
  return (
    <section className="desk-set-card" aria-label="Calendars">
      <h2>Calendars</h2>
      <p className="desk-set-sub">Choose which calendars appear on your Desk and give each one a colour.</p>
      {rows.length === 0 && <p className="desk-set-empty">No calendars have been reported by your sources yet.</p>}
      <ul className="desk-set-list">
        {rows.map((c) => (
          <li key={calendarKey(c.source, c.name, c.calendarId)}>
            <label className="desk-calendar-toggle">
              <input type="checkbox" aria-label={`Show ${c.name} (${c.source}${c.calendarId ? ` · ${c.calendarId}` : ""})`} checked={c.enabled} disabled={busy} onChange={(e) => onChange({ source: c.source, name: c.name, ...(c.calendarId ? { calendarId: c.calendarId } : {}), enabled: e.target.checked })} />
              <span>{c.name}<small>{c.source}</small></span>
            </label>
            <input type="color" aria-label={`Colour for ${c.name} (${c.source}${c.calendarId ? ` · ${c.calendarId}` : ""})`} value={c.color} disabled={busy} onChange={(e) => onChange({ source: c.source, name: c.name, ...(c.calendarId ? { calendarId: c.calendarId } : {}), color: e.target.value })} />
          </li>
        ))}
      </ul>
      {error && <p className="desk-set-err" role="alert">{error}</p>}
    </section>
  );
}
