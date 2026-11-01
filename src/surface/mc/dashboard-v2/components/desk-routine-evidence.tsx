import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RoutineEvidenceRecord, RoutineLogFile, RoutineLogPage } from "../../desk/routine-evidence-contract";
import { appendEvidence, downloadLog, evidenceLabel, evidenceLimit, evidenceOrigin, failedExecution, readEvidence, readLog } from "../lib/routine-evidence";

const errorText = (error: unknown): string => error instanceof Error ? error.message : "The evidence owner did not answer.";
export function EvidenceDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { element?.close(); }; }, []);
  return <dialog ref={dialog} className="routine-evidence-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}><header className="routine-workspace-heading"><h2>{title}</h2><button className="desk-btn" type="button" onClick={onClose}>Close</button></header>{children}</dialog>;
}
function LogFile({ record, file }: { record: RoutineEvidenceRecord; file: RoutineLogFile }) {
  const [page, setPage] = useState<RoutineLogPage | null>(null); const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [wrap, setWrap] = useState(true); const [restart, setRestart] = useState(0);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const controller = useRef<AbortController | null>(null); const requests = useRef(0);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; requests.current = 1;
    setPage(null); setText(""); setError(null);
    if (file.availability !== "available") return () => { abort.abort(); };
    setBusy(true);
    void readLog(record, file, abort.signal).then((result) => { if (!abort.signal.aborted) { setPage(result); setText(result.content); } }).catch((failure: unknown) => { if (!abort.signal.aborted) setError(errorText(failure)); }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => { abort.abort(); };
  }, [record, file, restart]);
  const more = async (): Promise<void> => {
    const abort = controller.current;
    if (page?.nextOffset === undefined || page.nextOffset === null || !abort || busy || error) return;
    setBusy(true);
    try {
      if (++requests.current > 64 || page.nextOffset >= evidenceLimit) throw new Error("The viewer reached its bounded limit. Download is limited to 4 MB too.");
      const next = await readLog(record, file, abort.signal, page.nextOffset, page.revision, page.totalBytes);
      if (!abort.signal.aborted) { setPage(next); setText((previous) => previous + next.content); }
    } catch (failure) { if (!abort.signal.aborted) { setPage(null); setText(""); setError(`${errorText(failure)} Restart the file read; previous bytes were cleared.`); } }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const download = async (): Promise<void> => {
    const abort = controller.current; if (!abort || downloadBusy) return;
    setDownloadBusy(true); setError(null);
    try {
      const blob = await downloadLog(record, file, abort.signal);
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = file.filename; link.click(); setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
    } catch (failure) { if (!abort.signal.aborted) setError(errorText(failure)); }
    finally { if (!abort.signal.aborted) setDownloadBusy(false); }
  };
  if (file.availability !== "available") return <p role="status">{file.reason ?? "This file is unavailable under the owner's retention policy."}</p>;
  return <section aria-label={`File ${file.filename}`}><p>Redacted structured process lifecycle records. Action stdout, stderr and per-step results are not available from this owner.</p><div className="desk-acts"><label><input type="checkbox" checked={wrap} onChange={(event) => { setWrap(event.target.checked); }} /> Wrap lines</label><button className="desk-btn" type="button" disabled={downloadBusy || busy || Boolean(error)} onClick={() => { void download(); }}>{downloadBusy ? "Downloading…" : "Download file"}</button><button className="desk-btn" type="button" disabled={busy || downloadBusy} onClick={() => { setRestart((n) => n + 1); }}>Restart file read</button></div>
    {busy && <p role="status">Reading bounded log page…</p>}{error && <p role="alert">{error}</p>}
    <pre className={`routine-log-content${wrap ? " routine-log-wrap" : ""}`} tabIndex={0} aria-label="Log text">{text}</pre>
    {page && <p>{page.complete ? "Complete file" : "Partial file"} · {page.totalBytes} bytes recorded{!page.complete && " · owner-bounded pages"}</p>}
    {page?.nextOffset !== null && page && <button className="desk-btn" type="button" disabled={busy || Boolean(error)} onClick={() => { void more(); }}>Load next log page</button>}
  </section>;
}
function ExecutionViewer({ record, origin, onClose }: { record: RoutineEvidenceRecord; origin: string; onClose: () => void }) {
  const execution = record.execution;
  const files = execution.kind === "observed" ? execution.files : [];
  const [selected, setSelected] = useState(files.find((file) => file.availability === "available")?.ref ?? files[0]?.ref);
  const file = files.find((entry) => entry.ref === selected);
  return <EvidenceDialog title={record.routineName} onClose={onClose}><p>{!record.definitionPresent && "Routine deleted; retained historical evidence. "}{evidenceLabel(record)} · {origin}</p><p>Recorded decision: <time dateTime={record.at}>{new Date(record.at).toLocaleString()}</time></p>
    {execution.kind === "observed" ? <><p>Started: <time dateTime={execution.startedAt}>{new Date(execution.startedAt).toLocaleString()}</time> · {execution.durationMs === null ? "Duration unavailable" : `${execution.durationMs} ms`}{execution.freshness === "stale" && " · Stale observation; current process state unconfirmed"}</p><p>Per-step results are unavailable. The process audit records lifecycle evidence only.</p><div className="routine-log-layout"><nav aria-label="Execution log files">{files.map((entry) => <button className="desk-btn" key={entry.ref} type="button" aria-pressed={entry.ref === selected} onClick={() => { setSelected(entry.ref); }}>{entry.filename}<small>{entry.availability === "available" ? "Redacted process audit" : "Unavailable"}</small></button>)}</nav>{file ? <LogFile key={file.ref} record={record} file={file} /> : <p>No authorized files were returned.</p>}</div></> : <p role="status">{execution.reason}{execution.kind === "unavailable" ? ` Evidence: ${execution.evidence}. Refresh history to check for delayed or retained records.` : ""}</p>}
    <details><summary>Recorded references</summary><dl><dt>Routine</dt><dd>{record.routineId}</dd><dt>Decision</dt><dd>{record.decisionId}</dd><dt>Historical target</dt><dd>{record.target ?? "Not recorded"}</dd></dl></details>
  </EvidenceDialog>;
}
export function RoutineEvidenceList({ routineId, active = true, revision = 0, compact = false, onAll }: { routineId: string | null; active?: boolean; revision?: number; compact?: boolean; onAll?: () => void }) {
  const [state, setState] = useState<{ key: string; records: RoutineEvidenceRecord[]; cursor: string | null; complete: boolean; pages: number } | null>(null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0); const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<{ key: string; record: RoutineEvidenceRecord } | null>(null);
  const controller = useRef<AbortController | null>(null); const cursors = useRef(new Set<string>());
  const key = JSON.stringify([routineId, revision, refresh]); const current = state?.key === key ? state : null;
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController(); controller.current = abort; cursors.current = new Set(); setError(null); setBusy(true); setSelection(null);
    void readEvidence(routineId, null, abort.signal).then((page) => { if (!abort.signal.aborted) setState({ key, records: appendEvidence([], page.records), cursor: page.nextCursor, complete: page.complete, pages: 1 }); }).catch((failure: unknown) => { if (!abort.signal.aborted) { setState(null); setError(errorText(failure)); } }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => { abort.abort(); };
  }, [key, routineId, active]);
  const more = async (): Promise<void> => {
    const abort = controller.current; if (!current?.cursor || busy || !abort) return;
    setBusy(true); setError(null);
    try {
      if (current.pages >= 40 || cursors.current.has(current.cursor)) throw new Error("History reached its bounded page limit or repeated a cursor. Refresh to restart.");
      cursors.current.add(current.cursor);
      const page = await readEvidence(routineId, current.cursor, abort.signal);
      if (page.nextCursor && cursors.current.has(page.nextCursor)) throw new Error("History repeated a cursor. Refresh to restart.");
      const records = appendEvidence(current.records, page.records);
      if (!abort.signal.aborted) setState({ key, records, cursor: page.nextCursor, complete: page.complete, pages: current.pages + 1 });
    } catch (failure) { if (!abort.signal.aborted) setError(errorText(failure)); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const records = current?.records.filter((record) => !failed || failedExecution(record)) ?? [];
  return <section className="routine-evidence" aria-label={routineId ? "Routine execution history" : "Stack execution activity"}><div className="routine-workspace-heading"><h3>{compact ? "Recent executions" : routineId ? "Execution history" : "Recent stack activity"}</h3><div className="desk-acts">{compact && <button className="desk-btn" type="button" onClick={onAll}>All executions</button>}<button className="desk-btn" type="button" disabled={busy} onClick={() => { setRefresh((n) => n + 1); }}>Refresh history</button></div></div>
    {!routineId && <label><input type="checkbox" checked={failed} onChange={(event) => { setFailed(event.target.checked); }} /> Failed executions only</label>}
    {busy && <p role="status">Reading recorded execution evidence…</p>}{error && <p role="alert">{error} History is unavailable or incomplete; this is not an empty result.</p>}
    {current && <><p className="soft">{current.records.length} loaded records · {current.complete ? "Owner history complete" : "Partial owner history; more pages available"}. Times use your browser timezone. Counts cover loaded records only.</p>{records.length === 0 && <p>{failed ? "No recorded process failures in the loaded records." : "No execution or decision records were returned."}</p>}
    <ul className="routine-execution-list">{(compact ? records.slice(0, 3) : records).map((record) => <li key={record.decisionId}><button type="button" onClick={() => { setSelection({ key, record }); }}><strong>{routineId ? evidenceLabel(record) : record.routineName}</strong><span>{!record.definitionPresent && "Deleted routine · "}{!routineId && `${evidenceLabel(record)} · `}{evidenceOrigin(record, current.records)}</span><time dateTime={record.execution.kind === "observed" ? record.execution.startedAt : record.at}>{record.execution.kind === "observed" ? "Started " : "Decision "}{new Date(record.execution.kind === "observed" ? record.execution.startedAt : record.at).toLocaleString()}</time><small>{record.execution.kind === "observed" && record.execution.durationMs !== null ? `${record.execution.durationMs} ms` : "Duration unavailable"} · Inspect evidence →</small></button></li>)}</ul>
    {!compact && current.cursor && <button className="desk-btn" type="button" disabled={busy || Boolean(error) || current.pages >= 40} onClick={() => { void more(); }}>Load more history</button>}{current.pages >= 40 && !current.complete && <p>Bounded history limit reached. These records are incomplete.</p>}</>}
    {active && selection?.key === key && <ExecutionViewer key={selection.record.decisionId} record={selection.record} origin={evidenceOrigin(selection.record, current?.records)} onClose={() => { setSelection(null); }} />}
  </section>;
}
export function RoutineActivity({ onClose, revision }: { onClose: () => void; revision: number }) {
  return <EvidenceDialog title="Routine Activity" onClose={onClose}><p>Recorded stack decisions and executions, including deleted routines while the existing owners retain evidence.</p><RoutineEvidenceList routineId={null} revision={revision} /></EvidenceDialog>;
}
