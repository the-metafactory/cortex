import { useEffect, useState } from "react";
import { ACTIVE_LOGIN, answerLogin, cancelLogin, isWebUrl, readLogin, startLogin, type LoginView } from "../lib/codex-auth";
import { failureText } from "../lib/conversations";

const POLL_MS = 1_500;

interface ViewProps { login: LoginView | null; error: string | null; busy: boolean; onStart: () => void; onCancel: () => void; onAnswer: (text: string) => void }

export function CodexReconnectView({ login, error, busy, onStart, onCancel, onAnswer }: ViewProps) {
  const [answer, setAnswer] = useState("");
  const active = login !== null && ACTIVE_LOGIN.includes(login.state);
  return <div className="dcv-reconnect" role="group" aria-label="Reconnect Codex">
    {!active && login?.state !== "signed-in" && <button type="button" className="desk-btn pri" disabled={busy} onClick={onStart}>Reconnect Codex</button>}
    {active && <>
      {isWebUrl(login.url) && <p><a href={login.url} target="_blank" rel="noreferrer noopener">Open the Codex sign-in page</a>{login.instructions ? ` ${login.instructions}` : ""}</p>}
      {login.userCode && <p>Enter code <strong>{login.userCode}</strong> at {isWebUrl(login.verificationUri) ? <a href={login.verificationUri} target="_blank" rel="noreferrer noopener">{login.verificationUri}</a> : "the sign-in page"}.</p>}
      {login.message && <p role="status">{login.message}</p>}
      {login.prompt && <form onSubmit={e => { e.preventDefault(); if (answer.trim()) { onAnswer(answer.trim()); setAnswer(""); } }}>
        <label>{login.prompt.message}<input type="text" autoComplete="off" value={answer} onChange={e => { setAnswer(e.target.value); }} /></label>
        <button className="desk-btn pri" disabled={busy || !answer.trim()}>Submit</button>
      </form>}
      <button type="button" className="desk-btn" disabled={busy} onClick={onCancel}>Cancel sign-in</button>
    </>}
    {login?.state === "signed-in" && <p role="status">Codex is signed in again. Retry your message.</p>}
    {(login?.state === "cancelled" || login?.state === "failed") && login.error && <p role="alert">{login.error}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function CodexReconnect({ onSignedIn }: { onSignedIn?: () => void }) {
  const [login, setLogin] = useState<LoginView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (call: () => Promise<{ login: LoginView }>): Promise<void> => {
    setBusy(true);
    try { setLogin((await call()).login); setError(null); }
    catch (failed) { setError(failureText(failed, "Mission Control could not reach the Codex sign-in. Your message is still in the conversation.")); }
    finally { setBusy(false); }
  };
  const active = login !== null && ACTIVE_LOGIN.includes(login.state);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void readLogin().then(read => { if (read.login) setLogin(read.login); }, () => undefined); }, POLL_MS);
    return () => { clearInterval(timer); };
  }, [active]);
  useEffect(() => { if (login?.state === "signed-in") onSignedIn?.(); }, [login?.state, onSignedIn]);
  return <CodexReconnectView login={login} error={error} busy={busy} onStart={() => void run(startLogin)} onCancel={() => { if (login) void run(() => cancelLogin(login.id)); }} onAnswer={text => { if (login) void run(() => answerLogin(login.id, text)); }} />;
}
