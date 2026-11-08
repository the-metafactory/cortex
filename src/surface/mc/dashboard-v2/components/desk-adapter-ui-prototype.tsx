import { useRef, useState, type FormEvent } from "react";
import { DeskAdapterUiPrototypeLab } from "./desk-adapter-ui-prototype-lab";
import "./desk-conversation-task-prototype.css";

type Task = { title: string; note: string; area: string; project: string; due: string };
type Message = { speaker: "You" | "Ivy"; text: string };
type Status = "discussing" | "proposing" | "proposed" | "saving" | "saved";
const taskFromDiscussion: Task = {
  title: "Review the release checklist",
  note: "Check rollback steps and alert coverage. Agree who will run the checks and capture any gaps before the next release.",
  area: "Reliability", project: "Release readiness", due: "",
};
const conversation: Message[] = [
  { speaker: "You", text: "We should review the release checklist before the next release. Check the rollback steps, alert coverage and who will run the checks." },
  { speaker: "Ivy", text: "Let’s capture the gaps and agree the final steps before the release." },
];

export function DeskAdapterUiPrototype() {
  return new URLSearchParams(location.search).get("lab") === "1" ? <DeskAdapterUiPrototypeLab /> : <ConversationTaskPrototype />;
}

function ConversationTaskPrototype() {
  const [messages, setMessages] = useState<Message[]>(conversation);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("discussing");
  const [task, setTask] = useState<Task>(taskFromDiscussion);
  const [draft, setDraft] = useState<Task>(taskFromDiscussion);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [pane, setPane] = useState<"conversation" | "conversations" | "task">("conversation");
  const [writes, setWrites] = useState(0);
  const approvalStarted = useRef(false);
  const proposalStarted = useRef(false);
  const hasTask = status === "proposed" || status === "saving" || status === "saved";
  const append = (speaker: Message["speaker"], text: string) => { setMessages(current => [...current, { speaker, text }]); };
  const send = (text: string) => {
    const message = text.trim();
    if (!message) return;
    append("You", message);
    setInput("");
    if (!/\btask\b/i.test(message)) { append("Ivy", "We can refine that here. When you’re ready, ask me to turn it into a task."); return; }
    if (proposalStarted.current) { append("Ivy", approvalStarted.current ? status === "saved" ? "That task is already in Balance." : "That task is already being added to Balance." : "Here’s the task we’re reviewing."); return; }
    proposalStarted.current = true;
    setStatus("proposing");
    setTimeout(() => { append("Ivy", "Here’s a task for that."); setStatus("proposed"); }, 250);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); send(input); };
  const edit = () => { setDraft({ ...task }); setError(""); setEditing(true); };
  const saveChanges = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.title.trim()) { setError("Give this task a title."); return; }
    setTask({ ...draft }); setEditing(false); setError("");
  };
  const approve = () => {
    if (approvalStarted.current || status !== "proposed" || editing) return;
    approvalStarted.current = true;
    const approved = { ...task };
    setStatus("saving");
    setTimeout(() => { setTask(approved); setWrites(current => current + 1); setStatus("saved"); }, 400);
  };
  const destination = [task.area, task.project].filter(Boolean).join(" · ");
  const taskDetails = <><h2>{task.title}</h2><p className="dcp-note">{task.note}</p>{task.due && <p className="dcp-due">Due {task.due}</p>}</>;
  return <div className="desk dcp" data-task-prototype data-status={status} data-synthetic-writes={writes} data-external-writes="0">
    <header className="dcp-top"><a className="dcp-brand" href="?desk=adapter-ui-prototype"> <span className="desk-mark" />Desk</a><span className="dcp-sample">Sample data</span></header>
    <main className="dcp-main">
      {pane === "conversations" ? <section className="dcp-list"><h1>Conversations</h1><button type="button" onClick={() => { setPane("conversation"); }}>Release review <span>Continue conversation →</span></button></section> : pane === "task" ? <section className="dcp-task-detail"><button type="button" className="dcp-back" onClick={() => { setPane("conversation"); }}>← Back to conversation</button><article className="dcp-card"><div className="dcp-card-meta"><span className="dcp-balance">Balance</span><span>{destination}</span></div>{taskDetails}<p className="dcp-created"><span aria-hidden="true">✓</span> Added to Balance</p></article></section> : <>
        <div className="dcp-heading"><button type="button" className="dcp-back" onClick={() => { setPane("conversations"); }}>← Conversations</button><h1>Release review</h1></div>
        <section className="dcp-thread" aria-label="Conversation">
          {messages.map((message, index) => <div key={index} className={`dcp-message ${message.speaker === "You" ? "dcp-you" : "dcp-ivy"}`}><strong>{message.speaker}</strong><p>{message.text}</p></div>)}
          {status === "proposing" && <p className="dcp-thinking" role="status">Ivy is writing…</p>}
          {hasTask && <article className="dcp-card" aria-label={status === "saved" ? "Saved Balance task" : "Proposed Balance task"}>
            <div className="dcp-card-meta"><span className="dcp-balance">Balance</span><span>{destination}</span></div>
            {editing ? <form className="dcp-edit" onSubmit={saveChanges}>
              <label>Title<input aria-label="Title" value={draft.title} aria-invalid={Boolean(error)} aria-describedby={error ? "task-title-error" : undefined} onChange={event => { setDraft({ ...draft, title: event.target.value }); setError(""); }} autoFocus /></label>
              {error && <p id="task-title-error" className="dcp-error" role="alert">{error}</p>}
              <label>Note<textarea aria-label="Note" value={draft.note} onChange={event => { setDraft({ ...draft, note: event.target.value }); }} /></label>
              <details><summary>More task details</summary><div className="dcp-extra-fields"><label>Area<select aria-label="Area" value={draft.area} onChange={event => { setDraft({ ...draft, area: event.target.value }); }}><option>Reliability</option><option>Inbox</option></select></label><label>Project<input aria-label="Project" value={draft.project} onChange={event => { setDraft({ ...draft, project: event.target.value }); }} /></label><label>Due<input aria-label="Due" type="date" value={draft.due} onChange={event => { setDraft({ ...draft, due: event.target.value }); }} /></label></div></details>
              <div className="dcp-actions"><button className="dcp-primary" type="submit">Save changes</button><button type="button" onClick={() => { setEditing(false); setError(""); }}>Cancel</button></div>
            </form> : <>{taskDetails}{status === "saved" ? <div className="dcp-saved"><p className="dcp-created" role="status"><span aria-hidden="true">✓</span> Added to Balance</p><button type="button" className="dcp-view-task" onClick={() => { setPane("task"); }}>View task →</button></div> : <div className="dcp-actions"><button type="button" className="dcp-primary" onClick={approve} disabled={status === "saving"}>{status === "saving" ? "Adding…" : "Approve"}</button><button type="button" onClick={edit} disabled={status === "saving"}>Edit</button></div>}</>}
          </article>}
        </section>
        {status === "discussing" && <button type="button" className="dcp-suggestion" onClick={() => { send("Turn this into a task"); }}>Turn this into a task</button>}
        <form className="dcp-composer" onSubmit={submit}><textarea aria-label="Message Ivy" placeholder="Message Ivy…" value={input} onChange={event => { setInput(event.target.value); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button type="submit" aria-label="Send message" disabled={!input.trim()}>Send</button></form>
      </>}
    </main>
  </div>;
}
