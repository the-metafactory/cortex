import type { VigilSubjectView } from "../../api/vigil";
import "./vigil-view.css";

export interface VigilViewProps {
  subjects: VigilSubjectView[];
  loaded: boolean;
  enabled?: boolean;
  error?: string | null;
}

function Timestamp({ value }: { value: number | null }) {
  if (value === null) return null;
  const iso = new Date(value).toISOString();
  return <time dateTime={iso}>{iso}</time>;
}

export function VigilView({ subjects, loaded, enabled = true, error }: VigilViewProps) {
  return (
    <section className="scaffold-section vigil-view" aria-label="Watching">
      <h2>Watching</h2>
      {!loaded ? (
        <p className="dim">Loading…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !enabled ? (
        <p className="dim">Vigil is not enabled on this stack.</p>
      ) : subjects.length === 0 ? (
        <p className="dim">No subjects watched yet.</p>
      ) : (
        <div className="vigil-table-scroll">
          <table>
            <caption className="dim">Vigil subjects</caption>
            <thead>
              <tr>
                <th scope="col">Subject</th>
                <th scope="col">Kind</th>
                <th scope="col">Vocabulary</th>
                <th scope="col">Reference</th>
                <th scope="col">Goal</th>
                <th scope="col">State</th>
                <th scope="col">Healthy</th>
                <th scope="col">Last result</th>
                <th scope="col">Last run</th>
                <th scope="col">Last ended</th>
                <th scope="col">Expected by</th>
              </tr>
            </thead>
            <tbody>
              {subjects.map((subject) => (
                <tr key={subject.subjectKey}>
                  <th scope="row" className="mono">{subject.subjectKey}</th>
                  <td>{subject.kind}</td>
                  <td>{subject.vocab ?? ""}</td>
                  <td className="mono">{subject.ref}</td>
                  <td>{subject.goalId === null ? "" : subject.goalWording ?? subject.goalId}</td>
                  <td>{subject.value}</td>
                  <td>{subject.healthy ? "Yes" : "No"}</td>
                  <td className="mono">{subject.lastResultRef ?? ""}</td>
                  <td className="mono">{subject.lastRunId}</td>
                  <td><Timestamp value={subject.lastEndedAt} /></td>
                  <td><Timestamp value={subject.expectedBy} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
