import { DeskBalance } from "./desk-balance";
import { MailSweeps, SweepPreview, sweepsInArea } from "./desk-mail-sweeps";
import type { MailSweepView } from "../../desk/mail-sweep";
import { useStudioForeground } from "../hooks/use-studio-foreground";
import { MailYesFilterBox, RecordedMailDecision } from "./desk-mail-yes-filter";
import { MyDayLane, submitMyDay } from "./desk-my-day";
import { StudioSessionPanel, useStudioSession } from "./desk-studio-session";
import { RoutinesSection, RoutineDone } from "./desk-routines";
import { DeskRoutineEditor } from "./desk-routine-editor";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getJson, postJson } from "../lib/api";
import { submitDeskAction, submitDmarcAck, submitGoalAction, submitMailAction, submitMailRule, submitRuling, type Outcome } from "../lib/desk-action";
import { afterFailure, cancelRuling, newRuling, RulingBox, type RulingDraft } from "./desk-ruling";
import { newReplyDraft, prepareDeclineDraft, ReplyDraftBox, type ReplyDraft } from "./desk-mail-draft";
import { chimeForNew } from "../lib/desk-chime";
import { browserNotifyEnv, dismissHint, notifyForNew, requestNotifications, wantsHint } from "../lib/desk-notify";
import { askDesk, createFromProposal } from "../lib/desk-ask";
import { ProposalCard, proposalTitle } from "./desk-proposal";
import { useRoutinesLocation, defaultRoutinesLocation } from "../hooks/use-routines-location";
import { useSettingsLocation } from "../hooks/use-settings-location";
import { DeskSettings } from "./desk-settings";
import { changeVips } from "../lib/desk-settings";
import { proposalTime, type DeskProposal } from "../../desk/ask";
import { DAY_MS, startOfDay } from "../../desk/time";
import "./desk-view.css";
import { useDesk } from "../hooks/use-desk";
import { useDeskLocation, useDeskStudio } from "../hooks/use-desk-studio";
import { DeskModeSwitch, DeskStudio } from "./desk-studio";
import { ALL_AREAS, briefing, canSee, clock, isBriefingRequest, openGroup, selectItems, spokenBriefing, URGENCY_LABEL } from "../../desk/present";
import { useDeskVoice } from "../hooks/use-desk-voice";
import { MicButton, VoicePanel } from "./desk-voice";
import type { DeskAction, DeskArea, DeskCorrection, DeskCorrectionMode, DeskEvent, DeskEvidence, DeskFoldedGroup, DeskItem, DeskItemKind, DeskPrecedent, DeskView as DeskViewModel } from "../../desk/types";
import type { MoveTarget } from "../../desk/mail-move";
import type { MailCorrection } from "../../desk/mail-actions";

interface DeskViewProps {
  onOpenMissionControl: () => void;
}

export function DeskView({ onOpenMissionControl }: DeskViewProps) {
  const { view, enabled, error, reload } = useDesk(true);
  const [settings, setSettings] = useSettingsLocation();
  const [routines, setRoutines] = useRoutinesLocation();
  const [visitedRoutines, setVisitedRoutines] = useState(routines);
  useEffect(() => { if (routines) setVisitedRoutines(routines); }, [routines]);
  const routineLocation = routines ?? visitedRoutines;
  if (!enabled) {
    return (
      <div className="desk desk-off">
        <p>The Desk is turned off for this stack (<code>mc.desk.enabled: false</code>).</p>
        <button type="button" className="desk-btn" onClick={onOpenMissionControl}>Open Mission Control</button>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="desk desk-loading">
        <p>{error ?? "Loading your Desk…"}</p>
        <button type="button" className="desk-btn" onClick={onOpenMissionControl}>Open Mission Control</button>
      </div>
    );
  }
  return <>
    {routineLocation && <div hidden={!routines}><DeskRoutineEditor active={Boolean(routines)} location={routineLocation} onLocation={setRoutines} view={view.routines} onChanged={reload} onBack={() => { setRoutines(null); reload(); }} /></div>}
    {!routines && (settings ? <DeskSettings view={view} group={settings} onGroup={setSettings} onBack={() => { setSettings(null); reload(); }} /> : <DeskBody view={view} error={error} onOpenMissionControl={onOpenMissionControl} onOpenSettings={() => { setSettings("calendars"); }} onOpenRoutines={() => { setRoutines(visitedRoutines ?? defaultRoutinesLocation()); }} onChanged={reload} />)}
  </>;
}

export function DeskBody({ view, error, onOpenMissionControl, onOpenSettings = () => {}, onOpenRoutines, onChanged = () => {} }: { view: DeskViewModel; error: string | null; onOpenSettings?: () => void; onOpenRoutines?: () => void; onChanged?: () => void } & DeskViewProps) {
  const [area, setArea] = useState(ALL_AREAS);
  const [snoozed, setSnoozed] = useState<Set<string>>(() => new Set());
  const [detail, setDetail] = useState<DeskItem | null>(null);
  const [sweep, setSweep] = useState<MailSweepView | null>(null);
  const [sweeping, setSweeping] = useState(false);
  useEffect(() => {
    if (detail) setSweep(null);
  }, [detail]);
  const [openRest, setOpenRest] = useState(false);
  const [groupKind, setGroupKind] = useState<DeskItemKind | null>(null);
  const [openAgents, setOpenAgents] = useState(false);
  const [openStopped, setOpenStopped] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [sending, setSending] = useState<ReadonlyMap<string, string>>(() => new Map());
  const inFlight = useRef(new Set<string>());
  const [confirming, setConfirming] = useState<{ key: string; action: string } | null>(null);
  const [rulings, setRulings] = useState<ReadonlyMap<string, RulingDraft>>(() => new Map());
  const [replyDraft, setReplyDraft] = useState<ReplyDraft | null>(null);
  const setRuling = (key: string, next: (d: RulingDraft | undefined) => RulingDraft | null): void =>
    setRulings((m) => {
      const draft = next(m.get(key));
      const copy = new Map(m);
      if (draft) copy.set(key, draft);
      else copy.delete(key);
      return copy;
    });
  const [askText, setAskText] = useState("");
  const [asking, setAsking] = useState(false);
  const [proposal, setProposal] = useState<{ p: DeskProposal; said: string; requestId: string; fields: Record<string, unknown> } | null>(null);
  const [creating, setCreating] = useState(false);
  const askInput = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState(() => wantsHint(view.notifications, browserNotifyEnv()));
  const latest = useRef(view);
  const [place, go] = useDeskLocation();
  const [studioRevision, setStudioRevision] = useState(0);
  const studio = useDeskStudio(place.mode === "studio", studioRevision);
  const captureChanged = (): void => { setStudioRevision((n) => n + 1); onChanged(); };
  const inStudio = place.mode === "studio" && studio !== null;
  const inBalance = place.mode === "balance";
  const foreground = useStudioForeground(inStudio, view.mirror?.week.timeZone);

  const selection = useMemo(() => selectItems(view, area, snoozed), [view, area, snoozed]);
  const group = groupKind ? openGroup(selection, groupKind) : null;
  const areaLabel = area === ALL_AREAS ? null : view.areas.find((a) => a.id === area)?.label ?? null;
  const brief = briefing(view, selection, areaLabel);
  const areaById = new Map(view.areas.map((a) => [a.id, a]));
  const inArea = (e: DeskEvent): boolean => area === ALL_AREAS || e.area === area;
  const allDay = view.today.filter((e) => e.kind === "all-day" && inArea(e));
  const timed = view.today.filter((e) => e.kind !== "all-day");
  const pastAll = timed.filter((e) => e.at <= view.generatedAt && inArea(e));
  const stopped = pastAll.filter((e) => e.kind === "agent-stop");
  const past = pastAll.filter((e) => e.kind !== "agent-stop");
  const ghost = proposal ? ghostEvent({ ...proposal.p, fields: proposal.fields }) : null;
  const upcomingGhost = ghost !== null && ghost.at > view.generatedAt ? ghost : null;
  const ghostToday = upcomingGhost !== null && upcomingGhost.at < startOfDay(view.generatedAt) + DAY_MS;
  const withGhost = (list: DeskEvent[], include: boolean): DeskEvent[] => (upcomingGhost && include ? [...list, upcomingGhost].sort((a, b) => a.at - b.at) : list);
  const laterReal = timed.filter((e) => e.at > view.generatedAt && inArea(e));
  const nextMeeting = laterReal.find((e) => e.kind === "meeting");
  const later = withGhost(laterReal, ghostToday);
  const ahead = withGhost(view.ahead.filter(inArea), !ghostToday);

  useEffect(() => {
    latest.current = view;
    chimeForNew(view);
    notifyForNew(view, (key) => {
      const found = latest.current.items.find((i) => i.key === key);
      if (found) setDetail(found);
    });
  }, [view]);

  const checking = view.items.some((i) => i.checking === true);
  useEffect(() => {
    if (!checking) return;
    const t = setInterval(onChanged, CHECK_POLL_MS);
    return () => clearInterval(t);
  }, [checking, onChanged]);

  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        askInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ask = async (): Promise<void> => {
    const text = askText.trim();
    if (!text || asking) return;
    setAsking(true);
    try {
      const result = await askDesk(text, fetch, area === ALL_AREAS ? undefined : area);
      if (!result.ok) {
        setNote(result.text);
        return;
      }
      await propose(text, result.proposal);
      setAskText("");
    } finally {
      setAsking(false);
    }
  };

  const propose = async (said: string, p: DeskProposal): Promise<string | null> => {
    const requestId = crypto.randomUUID();
    setGroupKind(null);
    if (p.kind === "capture" && p.automatic && !p.problem) {
      const filed = await createFromProposal(requestId, p.kind, p.fields);
      setNote(filed.text);
      if (filed.ok) {
        captureChanged();
        return filed.text;
      }
      setProposal({ p, said, requestId, fields: p.fields });
      return `${filed.text} Your thought is kept in the draft for retry.`;
    }
    setProposal({ p, said, requestId, fields: p.fields });
    return null;
  };

  const discussion = useStudioSession(captureChanged);
  const voice = useDeskVoice({ ...view.voice, enabled: view.voice.enabled && !discussion.session }, {
    answer: async (said) => {
      const result = await askDesk(said, fetch, area === ALL_AREAS ? undefined : area);
      if (!result.ok) return result.text;
      const filed = await propose(said, result.proposal);
      if (filed) return filed;
      return `I drafted this ${result.proposal.label.toLowerCase()}: ${proposalTitle(result.proposal)}. Confirm it on screen.`;
    },
    briefing: () => spokenBriefing(view, selection, areaLabel),
    isBriefing: isBriefingRequest,
    typeInstead: () => askInput.current?.focus(),
  });

  useEffect(() => { if (discussion.session) voice.dismiss(); }, [discussion.session?.id, voice.dismiss]);

  const confirm = async (fields: Record<string, unknown>): Promise<void> => {
    if (!proposal || creating) return;
    setCreating(true);
    const result = await createFromProposal(proposal.requestId, proposal.p.kind, fields);
    setCreating(false);
    setNote(result.text);
    if (!result.ok && !result.uncertain) return;
    setProposal(null);
    if (proposal.p.kind === "capture") captureChanged();
    else onChanged();
  };

  const undoCapture = async (id: string): Promise<void> => {
    try {
      const result = await postJson<{ id: string; requestId: string }, { message: string }>("/api/desk/capture/undo", { id, requestId: crypto.randomUUID() });
      setNote(result.message);
      captureChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not undo that capture.");
    }
  };

  const doneNote = async (id: string, itemKey: string | null): Promise<void> => {
    try {
      await postJson("/api/desk/notes/done", { id: Number(id) });
      if (itemKey) setSnoozed((s) => new Set(s).add(itemKey));
      onChanged();
    } catch {
      setNote("Could not mark that done.");
    }
  };

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(t);
  }, [note]);

  useEffect(() => {
    if (!receipt) return;
    const t = setTimeout(() => setReceipt(null), RECEIPT_MS);
    return () => clearTimeout(t);
  }, [receipt]);

  const undoMove = async (id: string): Promise<void> => {
    setReceipt(null);
    const result = await submitMailAction({ action: "undo", move: id });
    setNote(result.text);
    if (!result.ok) return;
    const restored = result.restored;
    if (restored) setSnoozed((s) => { const next = new Set(s); next.delete(restored); return next; });
    onChanged();
  };

  const undoRuleRun = async (id: string): Promise<void> => {
    const result = await submitMailRule({ op: "undo", run: id });
    setNote(result.text);
    if (!result.ok) return;
    const restored = result.restored;
    if (restored) setSnoozed((s) => { const next = new Set(s); next.delete(restored); return next; });
    onChanged();
  };

  const stopRule = async (rule: string): Promise<void> => {
    const result = await submitMailRule({ op: "stop", rule });
    setNote(result.text);
    if (result.ok) onChanged();
  };

  const undoSweep = async (id: string): Promise<void> => {
    const result = await submitMailAction({ action: "sweep.undo", sweep: id });
    setNote(result.text);
    if (result.ok) onChanged();
  };

  const confirmSweep = async (s: MailSweepView, keys: string[]): Promise<void> => {
    setSweeping(true);
    const result = await submitMailAction({ action: "sweep", sweep: s.id, keys });
    setSweeping(false);
    setNote(result.text);
    if (!result.ok) return;
    setSweep(null);
    onChanged();
  };

  const openSweep = (s: MailSweepView): void => {
    setDetail(null);
    setSweep(s);
  };

  const undoBy: Record<string, (id: string) => Promise<void>> = { "mail.move": undoMove, "mail.rule": undoRuleRun, "mail.sweep": undoSweep };
  const undoDone = (id: string, action?: string): void => void (undoBy[action ?? ""] ?? undoCapture)(id);

  const blockDomain = async (r: Receipt): Promise<void> => {
    if (!r.confirmBlock) {
      setReceipt({ ...r, confirmBlock: true });
      return;
    }
    setReceipt(null);
    const result = await submitMailAction({ action: "block", move: r.undo });
    setNote(result.text);
    if (result.ok) onChanged();
  };

  const run = (item: DeskItem, a: DeskAction): void => {
    const goal = item.goal ?? "";
    if (a.id === "detail") setDetail(item);
    else if (a.id === "snooze") setSnoozed((s) => new Set(s).add(item.key));
    else if (a.id === "todo" && view.myDay) void send(item, a, {
      keepVisible: true,
      request: async () => {
        try {
          await submitMyDay(view.myDay?.date ?? "", { op: "todo", key: item.key, fingerprint: item.todoFingerprint ?? "" });
          setDetail(d => d?.key === item.key && d.todoFingerprint === item.todoFingerprint ? null : d);
          return { ok: true, text: "Moved to your outline Inbox." };
        } catch (err) { return { ok: false, text: err instanceof Error ? err.message : "Could not move to Inbox." }; }
      },
    });
    else if (a.id === "vip.add" && a.target) void addVip(a.target, item.title.split(" wrote:")[0] ?? null);
    else if (a.id === "reminder.done" && a.target) {
      setDetail((d) => (d?.key === item.key ? null : d));
      void doneNote(a.target, item.key);
    }
    else if (a.id === "ranger.rule" && a.wired) openRuling(item);
    else if (a.id.startsWith("ranger.") && a.wired) void send(item, a);
    else if (a.id === "goal.check" && a.wired && item.goal) void send(item, a, { request: () => submitGoalAction({ action: a.id, goal }), keepVisible: true });
    else if (a.id === "goal.pause" && item.goal) confirmFirst(item, a, () => void send(item, a, { request: () => submitGoalAction({ action: a.id, goal }) }));
    else if (a.id === "mail.seen") move(item, a, "trash");
    else if (a.id === "mail.trash") confirmFirst(item, a, () => move(item, a, "trash"));
    else if (a.id === "mail.archive") move(item, a, "archive");
    else if (a.id === "mail.spam") confirmFirst(item, a, () => move(item, a, "junk"));
    else if (a.id === "mail.draft" && item.reply) openReply(item);
    else if (a.id === "mail.unimportant") void send(item, a, { request: () => submitMailAction({ action: "unimportant", key: item.key }) });
    else if (a.id === "mail.report") void send(item, a, { request: () => submitMailAction({ action: "report", key: item.key }), keepVisible: true });
    else if (a.id.startsWith("mailrule.")) runRule(item, a);
    else if (a.id === "dmarc.ack" && a.target) acknowledge(item, a, a.target);
    else if (a.id === "meeting.show" && a.target) showEvent(a.target);
    else if (a.url) openLink(a.url);
    else setNote(`"${a.label}" is not connected yet.`);
  };

  const acknowledge = (item: DeskItem, a: DeskAction, report: string): void => void send(item, a, { request: () => submitDmarcAck(report) });

  const runRule = (item: DeskItem, a: DeskAction): void => {
    const op = a.id.slice("mailrule.".length);
    const rule = a.target;
    if (op === "approve" || op === "later" || op === "never") void send(item, a, { request: () => submitMailRule({ op, proposal: item.key }) });
    else if ((op === "release" || op === "stop") && rule) void send(item, a, { request: () => submitMailRule({ op, rule }) });
  };

  const openRuling = (item: DeskItem): void => {
    setDetail(item);
    setRuling(item.key, (r) => (r ? { ...r, open: true } : newRuling(item.key, crypto.randomUUID())));
  };

  const confirmRuling = (item: DeskItem, draft: RulingDraft): void => {
    const rule: DeskAction = { id: "ranger.rule", label: "Give your ruling", role: "primary", wired: true };
    void send(item, rule, {
      request: async () => {
        const result = await submitRuling({ key: item.key, text: draft.text, requestId: draft.requestId });
        setRuling(item.key, (r) => (r?.requestId !== draft.requestId ? r ?? null : result.ok ? null : afterFailure(r, result)));
        return result;
      },
    });
  };

  const openReply = (item: DeskItem): void => {
    setDetail(item);
    setReplyDraft((r) => (r?.key === item.key ? r : newReplyDraft(item.key)));
  };

  const confirmReply = (item: DeskItem, draft: ReplyDraft): void => {
    const save: DeskAction = { id: "mail.draft", label: "Draft a reply", role: "primary", wired: true };
    void send(item, save, {
      keepVisible: true,
      request: async () => {
        const result = await submitMailAction({ action: "draft", key: item.key, body: draft.text, ...(item.yesFilter ? { decision: { requestId: draft.requestId, commitment: draft.commitment ?? null, intent: draft.intent } } : {}) });
        setReplyDraft((r) => (r?.key !== item.key ? r : result.ok ? null : { ...r, note: result.text }));
        return result;
      },
    });
  };

  const move = (item: DeskItem, a: DeskAction, target: MoveTarget): void => void send(item, a, { request: () => submitMailAction({ action: "move", key: item.key, target }) });

  const confirmFirst = (item: DeskItem, a: DeskAction, go: () => void): void => {
    if (confirming?.key === item.key && confirming.action === a.id) {
      setConfirming(null);
      go();
    } else setConfirming({ key: item.key, action: a.id });
  };

  const send = async (item: DeskItem, action: DeskAction, { request, keepVisible = false }: SendOptions = {}): Promise<void> => {
    if (inFlight.current.has(item.key)) return;
    inFlight.current.add(item.key);
    setSending((m) => new Map(m).set(item.key, action.id));
    let result: Outcome;
    try {
      result = await (request ? request() : submitDeskAction({ action: action.id, key: item.key }));
    } finally {
      inFlight.current.delete(item.key);
      setSending((m) => {
        const next = new Map(m);
        next.delete(item.key);
        return next;
      });
    }
    if (result.ok && result.undo) setReceipt({ text: result.text, undo: result.undo, ...(result.block ? { block: result.block } : {}) });
    else setNote(result.text);
    if (!result.ok) return;
    if (!keepVisible) {
      setSnoozed((s) => new Set(s).add(item.key));
      setDetail((d) => (d?.key === item.key ? null : d));
    }
    onChanged();
  };

  const addVip = async (address: string, label: string | null): Promise<void> => {
    const r = await changeVips({ op: "add", address, label });
    if (!r.ok) {
      setNote(`Could not add ${address} as a VIP: ${r.text}`);
      return;
    }
    setNote(`Mail from ${label ?? address} will always show from now on. You can change this in Settings.`);
    onChanged();
  };

  const promote = async (action: string, on: boolean): Promise<void> => {
    try {
      const r = await postJson<{ action: string; on: boolean }, { message?: string }>("/api/desk/autonomy", { action, on });
      setNote(r.message ?? "Done.");
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not change that.");
    }
  };

  const correct = async (kind: DeskItemKind, source: string, mode: DeskCorrectionMode | null): Promise<void> => {
    try {
      const r = mode
        ? await postJson<{ kind: string; source: string; mode: DeskCorrectionMode }, { message?: string }>("/api/desk/corrections", { kind, source, mode })
        : await getJson<{ message?: string }>(`/api/desk/corrections?kind=${encodeURIComponent(kind)}&source=${encodeURIComponent(source)}`, { method: "DELETE" });
      setNote(r.message ?? "Done.");
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not change the ranking.");
    }
  };

  const correctMail = async (item: DeskItem, said: MailCorrection): Promise<void> => {
    const r = await submitMailAction({ action: "correct", key: item.key, said });
    setNote(r.text);
    if (r.ok) onChanged();
  };

  const shown = (item: DeskItem): DeskItem => (confirming?.key === item.key ? withConfirm(item, confirming.action) : item);
  const busyWith = (item: DeskItem): string | null => sending.get(item.key) ?? (item.checking ? "goal.check" : null);
  const originalDetail = detail ? view.items.find((i) => i.key === detail.key) ?? detail : null;
  const detailItem = originalDetail ? { ...originalDetail, more: [...(originalDetail.more ?? []), { id: "todo", label: "→ todo", role: "secondary" as const, wired: true }] } : null;
  const detailRuling = detailItem ? rulings.get(detailItem.key) : undefined;

  const itemRow = (item: DeskItem, idx: number) => (
    <DeskItemRow
      key={item.key}
      item={shown({ ...item, more: [...(item.more ?? []), { id: "todo", label: "→ todo", role: "secondary", wired: true }] })}
      rank={idx + 1}
      area={item.area ? areaById.get(item.area) : undefined}
      event={item.eventKey ? view.today.find((e) => e.key === item.eventKey) : undefined}
      onOpen={() => setDetail(item)}
      onAction={(a) => run(item, a)}
      sending={busyWith(item)}
      onFocusEvent={focusEvent}
      onCorrect={(mode) => void correct(item.kind, item.source, mode)}
      {...(item.kind === "mail" ? { onCorrectMail: (said: MailCorrection) => void correctMail(item, said) } : {})}
      rulingNote={rulings.get(item.key)?.note ?? null}
    />
  );

  const showEvent = (key: string): void => {
    setDetail(null);
    focusEvent(key);
  };

  const focusEvent = (key: string): void => {
    if (view.today.some((e) => e.key === key && e.kind === "agent-stop")) setOpenStopped(true);
    requestAnimationFrame(() => document.querySelector(`[data-event="${CSS.escape(key)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  const proposalCard = proposal && (
    <ProposalCard
      key={proposal.requestId}
      proposal={{ ...proposal.p, fields: proposal.fields }}
      said={proposal.said}
      maps={view.ask.maps}
      now={view.generatedAt}
      busy={creating}
      onConfirm={(fields) => void confirm(fields)}
      onCancel={() => setProposal(null)}
      onGoto={() => focusEvent(GHOST_KEY)}
      onFieldsChange={(fields) => setProposal((cur) => (cur ? { ...cur, fields } : cur))}
    />
  );

  return (
    <div className={`desk${detail || sweep ? " panel-open" : ""}${inStudio ? " in-studio" : ""}`}>
      <div className="desk-top">
        <div className="desk-top-in">
          <div className="desk-left">
            <div className="desk-brand"><span className="desk-mark" />Desk</div>
            <DeskModeSwitch hasStudio={studio !== null} inStudio={inStudio} inBalance={inBalance} onGo={(mode) => go({ mode, thread: null })} />
            <div className="desk-askwrap">
              <form
                className="desk-ask"
                onSubmit={(e) => {
                  e.preventDefault();
                  void ask();
                }}
              >
                <span className="desk-ask-lead">Ivy,</span>
                <input
                  ref={askInput}
                  className="desk-input"
                  aria-label="Ask Ivy"
                  placeholder="capture…, remind me…, note…, ask an agent to…, schedule…"
                  value={askText}
                  disabled={asking}
                  onChange={(e) => setAskText(e.target.value)}
                />
                {voice.available && <MicButton phase={voice.state.phase} onStart={voice.start} onStop={voice.stop} />}
                {asking ? <span className="desk-ask-busy" role="status">Thinking…</span> : <kbd className="desk-kbd">⌘K</kbd>}
              </form>
              <VoicePanel state={voice.state} onDismiss={voice.dismiss} />
            </div>
          </div>
          <div className="desk-topr">
            {!inStudio && !inBalance && view.areas.length > 0 && (
              <div className="desk-seg" role="tablist" aria-label="Area">
                <button type="button" role="tab" aria-selected={area === ALL_AREAS} onClick={() => setArea(ALL_AREAS)}>All</button>
                {view.areas.map((a) => (
                  <button key={a.id} type="button" role="tab" aria-selected={area === a.id} onClick={() => setArea(a.id)}>
                    <AreaDot area={a} />{a.label}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="desk-btn ghost" onClick={onOpenSettings}>Settings</button>
          </div>
        </div>
      </div>

      <StudioSessionPanel controls={discussion} voice={view.voice} location={`${place.mode}:${place.thread ?? ""}`} />
      {inStudio && studio && <DeskStudio studio={studio} thread={place.thread} day={view} onDiscuss={discussion.start} onOpenThread={(slug) => go({ mode: "studio", thread: slug })} />}
      {inStudio && (
        <div className="dst">
          {proposalCard}
          <DoneForYou routines={view.routines} onChanged={onChanged} autonomy={view.autonomy} onUndo={undoDone} onStop={(rule) => void stopRule(rule)} onPromote={(action, on) => void promote(action, on)} />
        </div>
      )}
      {inBalance && (view.myDay ? <DeskBalance day={view.myDay} view={view} foreground={foreground} onChanged={onChanged} onThread={(slug) => go({ mode: "studio", thread: slug })} /> : <p role="status">Your Balance outline is unavailable. Refresh the Desk to retry.</p>)}
      <div className="desk-grid" hidden={inStudio || inBalance}>
        <main>
          <section className="desk-lead">
            <p><strong>{brief.greeting}</strong> {brief.lines.join(" ")}</p>
            {error && <p className="desk-stale">{error}</p>}
          </section>
          {hint && (
            <NotifyHint
              onEnable={() => {
                setHint(false);
                void requestNotifications(view);
              }}
              onDismiss={() => {
                setHint(false);
                dismissHint(browserNotifyEnv());
              }}
            />
          )}

          <div className="desk-h">
            Today <span className="desk-date">{new Date(view.generatedAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</span>
            {allDay.map((e) => <span key={e.key} className="desk-pill" style={e.color ? { borderLeft: `3px solid ${e.color}` } : undefined}>{e.title}</span>)}
          </div>

          {(past.length > 0 || stopped.length > 0) && (
            <ol className="desk-tl desk-past">
              {stopped.length > 0 && (
                <li className="desk-ev">
                  <time>{clock(stopped[0]!.at)}</time>
                  <span className="desk-pin" />
                  <span>
                    <button type="button" className="desk-dhead" onClick={() => setOpenStopped((o) => !o)} aria-expanded={openStopped}>
                      <b>{stopped.length === 1 ? "An agent stopped" : `${stopped.length} agents stopped`}</b> since {clock(stopped[0]!.at)}
                      <span className={`desk-chev${openStopped ? " open" : ""}`}>›</span>
                    </button>
                  </span>
                </li>
              )}
              {openStopped && stopped.map((e) => (
                <li key={e.key} data-event={e.key} className="desk-ev did">
                  <time>{clock(e.at)}</time>
                  <span className="desk-pin" />
                  <span className="t">{e.note ?? e.title}</span>
                </li>
              ))}
              {past.map((e) => <TimelineRow key={e.key} event={e} className={e.kind === "agent" ? "agentrow" : ""} />)}
            </ol>
          )}

          <div className="desk-nowline"><span className="rule" /><span className="pill">Now {clock(view.generatedAt)}</span></div>

          <div className="desk-day-lanes">
          {group ? (
            <section className="desk-now" aria-label={group.label}>
              <div className="desk-row desk-nowhead">
                <div className="body">
                  <h2>{group.label}</h2>
                  <p>{group.items.length === 0 ? "Nothing left here." : `${group.items.length} that did not make your top ${view.topN}, most important first.`}</p>
                  <button type="button" className="desk-btn" onClick={() => setGroupKind(null)}>Back to what needs you</button>
                </div>
              </div>
              {group.items.map(itemRow)}
            </section>
          ) : (
          <section className="desk-now" aria-label="Needs you">
            <div className="desk-row desk-nowhead">
              <div className="body">
                <h2>{nowHeading(view, selection.needsYou.length, nextMeeting)}</h2>
                {nextMeeting && (
                  <p className="desk-next">
                    <b>{clock(nextMeeting.at)}{nextMeeting.end ? `–${clock(nextMeeting.end)}` : ""}</b> {nextMeeting.title}
                    {nextMeeting.url && <a href={nextMeeting.url} target="_blank" rel="noopener noreferrer">{nextMeeting.online ? "Join" : "Open"}</a>}
                  </p>
                )}
                <p>{nowSubline(view, selection.needsYou.length, selection.rest.length, nextMeeting)}</p>
              </div>
            </div>
            {!inStudio && proposalCard}
            <MailSweeps sweeps={sweepsInArea(view.mailSweeps ?? [], area)} onPreview={openSweep} />
            {selection.needsYou.map(itemRow)}
          </section>
          )}

          {view.myDay && <MyDayLane day={view.myDay} onChanged={onChanged} />}
          </div>

          {later.length > 0 && (
            <ol className="desk-tl desk-later">
              {later.map((e) => <TimelineRow key={e.key} event={e} className={e.key === GHOST_KEY ? "ghost" : e.kind} />)}
            </ol>
          )}

          {ahead.length > 0 && <AheadStrip events={ahead} />}
        </main>

        <aside className="desk-margin" aria-label="At a glance">
          <button className="desk-btn" type="button" onClick={onOpenRoutines}>Open Routines</button>
          <RoutinesSection view={view.routines} onChanged={onChanged} />
          <section className="desk-msec">
            <h3 className="desk-mh">Agents</h3>
            <button type="button" className="desk-mline" onClick={() => setOpenAgents((o) => !o)} aria-expanded={openAgents}>
              {view.agents.working.length > 0 && <span className="desk-pulse" />}
              {view.agents.line}
              <span className={`desk-chev${openAgents ? " open" : ""}`}>›</span>
            </button>
            {openAgents && (
              <ul className="desk-sub">
                {view.agents.working.map((w) => (
                  <li key={w.title}><span className="desk-pulse" /><div>{w.title}<small>{w.note} · since {clock(w.since)}</small></div></li>
                ))}
                {view.agents.waiting > 0 && <li><div>{view.agents.waiting} agent tasks wait on you<small>They are ranked with everything else.</small></div></li>}
              </ul>
            )}
          </section>

          <DoneForYou routines={view.routines} onChanged={onChanged} autonomy={view.autonomy} onUndo={undoDone} onStop={(rule) => void stopRule(rule)} onPromote={(action, on) => void promote(action, on)} />

          <section className="desk-msec">
            <h3 className="desk-mh">The rest</h3>
            <button type="button" className="desk-mline" onClick={() => setOpenRest((o) => !o)} aria-expanded={openRest} disabled={selection.rest.length === 0}>
              {selection.rest.length} more <span className="soft">nothing urgent</span>
              <span className={`desk-chev${openRest ? " open" : ""}`}>›</span>
            </button>
            {openRest && (
              <RestGroups groups={selection.groups} active={groupKind} onOpen={setGroupKind} />
            )}
          </section>

          {view.goals.length > 0 && (
            <section className="desk-msec">
              <h3 className="desk-mh">Goals</h3>
              <ul className="desk-goals">
                {view.goals.map((g) => (
                  <li key={g.id}><span>{g.text}</span><span className={`desk-st ${g.state}`}>{g.state.replace("-", " ")}</span></li>
                ))}
              </ul>
            </section>
          )}

          {view.notes.length > 0 && (
            <section className="desk-msec">
              <h3 className="desk-mh">Keep in mind</h3>
              <ul className="desk-vips desk-notes">
                {view.notes.map((n) => (
                  <li key={n.id}>
                    <span>{n.text}</span>
                    <button type="button" aria-label={`Put away "${n.text}"`} title="Put away" onClick={() => void doneNote(String(n.id), null)}>×</button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <RankingSection corrections={view.corrections} onUndo={(c) => void correct(c.kind, c.source, null)} />

          <section className="desk-msec">
            <h3 className="desk-mh">Systems</h3>
            {view.systems.length === 0 && canSee(view) ? (
              <p className="desk-health ok">Everything runs.</p>
            ) : (
              view.systems.map((s) => <p key={s} className="desk-health"><i />{s}</p>)
            )}
            {view.dmarc && <p className={view.dmarc.failures === 0 ? "desk-health ok" : "desk-health"}>{view.dmarc.failures === 0 ? null : <i />}{view.dmarc.line}</p>}
            <button type="button" className="desk-mline desk-mc" onClick={onOpenMissionControl}>
              Open Mission Control <span className="desk-chev">›</span>
            </button>
          </section>
        </aside>
      </div>

      <div className="desk-scrim" onClick={() => { setDetail(null); if (!sweeping) setSweep(null); }} />
      <aside className="desk-panel" aria-hidden={!detail && !sweep} aria-label="Details">
        {sweep && !detailItem && <SweepPreview key={sweep.id} sweep={sweep} busy={sweeping} onConfirm={(keys) => void confirmSweep(sweep, keys)} onCancel={() => setSweep(null)} />}
        {detailItem && (
          <DetailPanel item={shown(detailItem)} area={detailItem.area ? areaById.get(detailItem.area)?.label : undefined} onClose={() => setDetail(null)} onAction={(a) => run(detailItem, a)} onShowEvent={showEvent} sending={busyWith(detailItem)}>
            {detailRuling?.open && (
              <RulingBox
                item={detailItem}
                draft={detailRuling}
                sending={busyWith(detailItem) === "ranger.rule"}
                onChange={(text) => setRuling(detailItem.key, (r) => (r ? { ...r, text } : null))}
                onConfirm={() => confirmRuling(detailItem, detailRuling)}
                onCancel={() => setRuling(detailItem.key, (r) => cancelRuling(r ?? null))}
              />
            )}
            {detailItem.mailDecision && <RecordedMailDecision decision={detailItem.mailDecision} />}
            {detailItem.yesFilter && <MailYesFilterBox filter={detailItem.yesFilter} selected={replyDraft?.key === detailItem.key ? replyDraft.commitment : undefined} canDraft={Boolean(detailItem.reply)} disabled={busyWith(detailItem) === "mail.draft"} onChoose={commitment => setReplyDraft(r => ({ ...(r?.key === detailItem.key ? r : newReplyDraft(detailItem.key)), commitment, requestId: crypto.randomUUID() }))} onDecline={() => setReplyDraft(r => prepareDeclineDraft(r?.key === detailItem.key ? r : newReplyDraft(detailItem.key)))} />}
            {replyDraft?.key === detailItem.key && detailItem.reply && (
              <ReplyDraftBox
                reply={detailItem.reply}
                draft={replyDraft}
                sending={busyWith(detailItem) === "mail.draft"}
                onChange={(text) => setReplyDraft((r) => (r?.key === detailItem.key ? { ...r, text, requestId: crypto.randomUUID() } : r))}
                onConfirm={() => confirmReply(detailItem, replyDraft)}
                onCancel={() => setReplyDraft(null)}
              />
            )}
          </DetailPanel>
        )}
      </aside>

      {note ? <div className="desk-note" role="status">{note}</div> : receipt && <MailReceipt receipt={receipt} onUndo={() => void undoMove(receipt.undo)} onBlock={() => void blockDomain(receipt)} />}
    </div>
  );
}

function DetailPanel({ item, area, onClose, onAction, onShowEvent, sending, children }: { item: DeskItem; area?: string; onClose: () => void; onAction: (a: DeskAction) => void; onShowEvent: (key: string) => void; sending: string | null; children?: ReactNode }) {
  return (
    <>
      <div className="desk-panel-top">
        <span className="area">{area ?? "All"} · {URGENCY_LABEL[item.urgency]}</span>
        <button type="button" className="desk-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <h3>{item.title}</h3>
      <p className="desk-why">{item.why}</p>
      {item.suggestion && <p className="desk-why desk-suggest">{item.suggestion}</p>}
      {children}
      <div className="desk-sec">What this is</div>
      <p className="desk-summary">{item.detail.summary}</p>
      {item.detail.evidence && item.detail.evidence.length > 0 && (
        <>
          <div className="desk-sec">Evidence</div>
          <ul className="desk-evidence">{item.detail.evidence.map((e, i) => <li key={`${e.kind}:${i}`}><EvidenceLink evidence={e} onShowEvent={onShowEvent} /></li>)}</ul>
        </>
      )}
      {item.detail.suspicion && item.detail.suspicion.length > 0 && (
        <>
          <div className="desk-sec">Why this looks like phishing</div>
          <ul className="desk-hist desk-suspicion">{item.detail.suspicion.map((r) => <li key={r}>{r}</li>)}</ul>
        </>
      )}
      {item.detail.precedents && item.detail.precedents.length > 0 && (
        <>
          <div className="desk-sec">Why this suggestion</div>
          <ul className="desk-hist">{item.detail.precedents.map((p, i) => <li key={`${p.at}:${i}`}>{precedentText(p)}</li>)}</ul>
        </>
      )}
      {item.detail.history.length > 0 && (
        <>
          <div className="desk-sec">History</div>
          <ul className="desk-hist">{item.detail.history.map((h) => <li key={h}>{h}</li>)}</ul>
        </>
      )}
      {item.detail.links.length > 0 && (
        <>
          <div className="desk-sec">Open in</div>
          <div className="desk-links">
            {item.detail.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">{l.label}<span>↗</span></a>)}
          </div>
        </>
      )}
      <div className="desk-sec">References</div>
      <ul className="desk-refs">{item.detail.refs.map((r) => <li key={r}>{r}</li>)}</ul>
      <div className="desk-panel-acts">
        {[...item.actions, ...(item.more ?? [])].filter((a) => a.id !== "detail").map((a) => <ActionButton key={a.id} action={a} onRun={onAction} sending={sending} />)}
      </div>
    </>
  );
}

export const precedentText = (p: DeskPrecedent): string =>
  `“${p.subject}”, ${new Date(p.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}: ${p.correction ? "you said you would have " : ""}${p.action}`;

const EVIDENCE_KIND: Record<DeskEvidence["kind"], string> = { event: "Meeting", mail: "Mail", note: "Note" };

export function EvidenceLink({ evidence, onShowEvent }: { evidence: DeskEvidence; onShowEvent: (key: string) => void }) {
  const label = <><span className="k">{EVIDENCE_KIND[evidence.kind]}</span>{evidence.title}</>;
  const { eventKey, url } = evidence;
  if (eventKey) return <button type="button" onClick={() => onShowEvent(eventKey)}>{label}<span className="go">↑</span></button>;
  if (url) return <a href={url} target="_blank" rel="noopener noreferrer">{label}<span className="go">↗</span></a>;
  return <span>{label}</span>;
}

export function RestGroups({ groups, active, onOpen }: { groups: DeskFoldedGroup[]; active: DeskItemKind | null; onOpen: (kind: DeskItemKind | null) => void }) {
  return (
    <ul className="desk-sub">
      {groups.map((g) => (
        <li key={g.kind}>
          <button type="button" className="desk-group" aria-pressed={active === g.kind} onClick={() => onOpen(active === g.kind ? null : g.kind)}>
            <span className="n">{g.count}</span><div>{g.label}<small>{g.example}</small></div>
          </button>
        </li>
      ))}
    </ul>
  );
}

const GHOST_KEY = "ghost:proposal";

function ghostEvent(p: DeskProposal): DeskEvent | null {
  const { at, end } = proposalTime(p.kind, p.fields);
  if (at === undefined) return null;
  return {
    key: GHOST_KEY,
    at,
    ...(end !== undefined ? { end } : {}),
    title: proposalTitle(p),
    note: `Proposed ${p.label.toLowerCase()}`,
    area: null,
    kind: p.kind === "calendar" ? "meeting" : "reminder",
  };
}

export function TimelineRow({ event, className }: { event: DeskEvent; className: string }) {
  return (
    <li data-event={event.key} className={`desk-ev ${className}`.trim()}>
      <time>{clock(event.at)}</time>
      <span className="desk-pin" style={event.color ? { background: event.color, borderColor: event.color } : undefined} />
      <span>
        <span className="t">{event.title}</span>
        {event.note && <span className="m">{event.note}</span>}
        {event.url && event.kind === "meeting" && <a className="desk-join" href={event.url} target="_blank" rel="noopener noreferrer">{event.online ? "Join" : "Open"}</a>}
      </span>
    </li>
  );
}

function AreaDot({ area }: { area: DeskArea }) {
  return <span className="dot" style={{ background: area.color || "#a1a1aa" }} />;
}

interface DeskItemRowProps {
  item: DeskItem;
  rank: number;
  area?: DeskArea;
  event?: DeskEvent;
  onOpen: () => void;
  onAction: (a: DeskAction) => void;
  sending: string | null;
  onFocusEvent: (key: string) => void;
  onCorrect: (mode: DeskCorrectionMode | null) => void;
  onCorrectMail?: (said: MailCorrection) => void;
  rulingNote?: string | null;
}

function DeskItemRow({ item, rank, area, event, onOpen, onAction, sending, onFocusEvent, onCorrect, onCorrectMail, rulingNote }: DeskItemRowProps) {
  return (
    <article className="desk-row desk-item">
      <span className="desk-rank">{rank}</span>
      <span />
      <div className="body">
        <div className="desk-meta">
          {area && <span className="area"><AreaDot area={area} />{area.label}</span>}
          <span className={item.urgency === "today" || item.urgency === "now" ? "due" : ""}>{URGENCY_LABEL[item.urgency]}</span>
          {item.correction && <span className="desk-corr">{CORRECTION_TAG[item.correction]}</span>}
          {item.suspicious && <span className="desk-suspect">Looks like phishing</span>}
        </div>
        <button type="button" className="desk-title" onClick={onOpen}>{item.title}</button>
        <p className="desk-why">{item.why}</p>
        {item.suggestion && <p className="desk-why desk-suggest">{item.suggestion}</p>}
        {item.interrupt?.delivery === "failed" && <p className="desk-why desk-unsent">Not pushed: {item.interrupt.error}</p>}
        {item.interrupt?.delivery === "buffered" && <p className="desk-why desk-waiting">Waiting for Discord</p>}
        {rulingNote && <p className="desk-why desk-unsent">{rulingNote}</p>}
        {item.excerpt && <blockquote className="desk-excerpt">{item.excerpt}</blockquote>}
        <div className="desk-acts">
          {item.actions.map((a) => <ActionButton key={a.id} action={a} onRun={onAction} sending={sending} />)}
          {event && (
            <button type="button" className="desk-chip" onClick={() => onFocusEvent(event.key)}>
              {clock(event.at)} today ↑
            </button>
          )}
          <ItemMenu current={item.correction} onCorrect={onCorrect} {...(onCorrectMail ? { onCorrectMail } : {})} onTodo={() => onAction({ id: "todo", label: "→ todo", role: "secondary", wired: true })} />
        </div>
      </div>
    </article>
  );
}

const CORRECTION_TAG: Record<DeskCorrectionMode, string> = { less: "Less like this", always: "Always shown" };

const MENU: { mode: DeskCorrectionMode; label: string }[] = [
  { mode: "less", label: "Less like this" },
  { mode: "always", label: "Always show this" },
];

const RANKING_LABEL = "Ranking: less like this, always show";
const MAIL_MENU_LABEL = "Correct this mail's suggestion";

const MAIL_MENU: { said: MailCorrection; label: string }[] = [
  { said: "not-bulk", label: "This isn't bulk" },
  { said: "matters", label: "This matters" },
  { said: "archive", label: "Wrong suggestion: I would archive it" },
  { said: "reply", label: "Wrong suggestion: I would reply" },
  { said: "todo", label: "Wrong suggestion: I would make it a to-do" },
  { said: "keep", label: "Wrong suggestion: I would keep it" },
  { said: "junk", label: "Wrong suggestion: it is spam" },
  { said: "trash", label: "Wrong suggestion: I would delete it" },
];

export function dismissesMenu<T>(e: { type: string; key?: string; target: T }, root: { contains: (t: T) => boolean } | null): boolean {
  if (e.type === "keydown") return e.key === "Escape";
  return e.type === "mousedown" && root !== null && !root.contains(e.target);
}

export function ItemMenu({ current, onCorrect, onCorrectMail, onTodo, open: startOpen = false }: { current?: DeskCorrectionMode; onCorrect: (mode: DeskCorrectionMode | null) => void; onCorrectMail?: (said: MailCorrection) => void; onTodo?: () => void; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onEvent = (e: Event): void => {
      const target = e.target instanceof Node ? e.target : null;
      const key = e instanceof KeyboardEvent ? e.key : undefined;
      if (dismissesMenu({ type: e.type, key, target }, root.current)) setOpen(false);
    };
    window.addEventListener("keydown", onEvent);
    window.addEventListener("mousedown", onEvent);
    return () => {
      window.removeEventListener("keydown", onEvent);
      window.removeEventListener("mousedown", onEvent);
    };
  }, [open]);
  const pick = (mode: DeskCorrectionMode | null): void => {
    setOpen(false);
    onCorrect(mode);
  };
  return (
    <span className="desk-more" ref={root}>
      <button type="button" className="desk-btn desk-rank-btn" aria-label={onCorrectMail ? MAIL_MENU_LABEL : RANKING_LABEL} title={onCorrectMail ? MAIL_MENU_LABEL : RANKING_LABEL} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <span className="desk-menu" role="menu">
          {onTodo && <button type="button" role="menuitem" onClick={() => { setOpen(false); onTodo(); }}>→ todo</button>}
          {onCorrectMail
            ? MAIL_MENU.map((m) => (
                <button key={m.said} type="button" role="menuitem" onClick={() => { setOpen(false); onCorrectMail(m.said); }}>{m.label}</button>
              ))
            : MENU.filter((m) => m.mode !== current).map((m) => (
                <button key={m.mode} type="button" role="menuitem" onClick={() => pick(m.mode)}>{m.label}</button>
              ))}
          {current && !onCorrectMail && <button type="button" role="menuitem" onClick={() => pick(null)}>Rank by the base rules again</button>}
        </span>
      )}
    </span>
  );
}

export function RankingSection({ corrections, onUndo }: { corrections: DeskCorrection[]; onUndo: (c: DeskCorrection) => void }) {
  if (corrections.length === 0) return null;
  return (
    <section className="desk-msec" aria-label="Ranking">
      <h3 className="desk-mh">Ranking</h3>
      <ul className="desk-vips">
        {corrections.map((c) => (
          <li key={`${c.kind}:${c.source}`}>
            <span>{CORRECTION_TAG[c.mode]}: {c.label}</span>
            <button type="button" aria-label={`Undo "${CORRECTION_TAG[c.mode]}" for ${c.label}`} title="Undo" onClick={() => onUndo(c)}>×</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Receipt {
  text: string;
  undo: string;
  block?: string;
  confirmBlock?: boolean;
}

const RECEIPT_MS = 12_000;

export function MailReceipt({ receipt, onUndo, onBlock }: { receipt: Receipt; onUndo: () => void; onBlock: () => void }) {
  return (
    <div className="desk-note desk-receipt" role="status">
      <span>{receipt.text}</span>
      <button type="button" className="desk-btn" onClick={onUndo}>Undo</button>
      {receipt.block && <button type="button" className="desk-btn" onClick={onBlock}>{receipt.confirmBlock ? `Yes, block ${receipt.block}` : `Also block ${receipt.block}`}</button>}
    </div>
  );
}

interface SendOptions {
  request?: () => Promise<Outcome>;
  keepVisible?: boolean;
}

const CHECK_POLL_MS = 3000;

const BUSY_LABEL: Record<string, string> = { "goal.check": "Checking…", "goal.pause": "Pausing…", "mail.seen": "Deleting…", "mail.trash": "Deleting…", "mail.archive": "Archiving…", "mail.spam": "Moving to Junk…", "mail.unimportant": "Saving…", "mail.draft": "Saving draft…", "mail.report": "Reporting…", "ranger.rule": "Recording…" };

const CONFIRM_LABEL: Record<string, string> = { "goal.pause": "Yes, pause it", "mail.trash": "Yes, move it to Trash", "mail.spam": "Yes, move it to Junk" };

export function withConfirm(item: DeskItem, actionId: string): DeskItem {
  const label = CONFIRM_LABEL[actionId];
  return label ? { ...item, actions: item.actions.map((a) => (a.id === actionId ? { ...a, label } : a)) } : item;
}

export function ActionButton({ action, onRun, sending }: { action: DeskAction; onRun: (a: DeskAction) => void; sending: string | null }) {
  const style = action.role === "primary" ? " pri" : action.id === "snooze" ? " ghost" : "";
  const busy = sending === action.id;
  return (
    <button
      type="button"
      className={`desk-btn${style}`}
      disabled={!action.wired || sending !== null}
      aria-busy={busy}
      title={action.wired ? undefined : "Not connected yet"}
      onClick={() => onRun(action)}
    >
      {busy ? BUSY_LABEL[action.id] ?? "Sending…" : action.label}
    </button>
  );
}

const MEETING_LEAD_MINUTES = 180;

const needsYouLine = (count: number): string => `${count === 1 ? "One thing needs" : `${count} things need`} you, most important first.`;

const minutesUntil = (view: DeskViewModel, next: DeskEvent | undefined): number => (next ? Math.round((next.at - view.generatedAt) / 60_000) : Infinity);

function nowHeading(view: DeskViewModel, count: number, next: DeskEvent | undefined): string {
  if (!canSee(view)) return "The Desk cannot see anything yet.";
  const minutes = minutesUntil(view, next);
  if (next && minutes <= MEETING_LEAD_MINUTES) {
    return `You have ${minutes < 60 ? `${minutes} minutes` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`} before your ${clock(next.at)}.`;
  }
  return count === 0 ? "You're clear." : needsYouLine(count);
}

function nowSubline(view: DeskViewModel, count: number, rest: number, next: DeskEvent | undefined): string {
  const lead = minutesUntil(view, next) <= MEETING_LEAD_MINUTES && canSee(view) && count > 0 ? needsYouLine(count) : "";
  const tail = rest > 0 ? `${rest} more can wait; they are in the margin.` : "";
  return [lead, tail].filter(Boolean).join(" ");
}

function openLink(url: string): void {
  if (/^https?:/i.test(url)) window.open(url, "_blank", "noopener");
  else if (/^message:/i.test(url)) window.location.assign(url);
}

export function AheadStrip({ events }: { events: DeskEvent[] }) {
  const days = new Map<string, DeskEvent[]>();
  for (const e of events) {
    const day = new Date(e.at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return (
    <section className="desk-days" aria-label="Next days">
      {[...days.entries()].slice(0, 4).map(([day, list]) => (
        <div key={day} className="desk-day">
          <h3>{day}</h3>
          <ul>
            {list.map((e) => (
              <li key={e.key} data-event={e.key} className={e.key === GHOST_KEY ? "ghost" : undefined} style={e.color ? { borderLeft: `3px solid ${e.color}`, paddingLeft: 6 } : undefined}>
                {(e.kind === "meeting" || e.kind === "reminder") && <time>{clock(e.at)}</time>}
                <span className="ttl">{e.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

const ownLine = (d: DeskViewModel["autonomy"]["done"][number]): boolean => d.action !== undefined;

export function DoneForYou({ autonomy, onPromote, onUndo, onStop, routines, onChanged = () => {} }: { autonomy: DeskViewModel["autonomy"]; onPromote: (action: string, on: boolean) => void; onUndo?: (id: string, action?: string) => void; onStop?: (rule: string) => void; routines?: DeskViewModel["routines"]; onChanged?: () => void }) {
  if (autonomy.types.length === 0 && autonomy.done.length === 0 && !routines?.done.length) return null;
  const anyOn = autonomy.types.some((t) => t.on);
  return (
    <section className="desk-msec" aria-label="Done for you">
      <h3 className="desk-mh">Done for you</h3>
      <ul className="desk-sub desk-done">
        <RoutineDone view={routines} onChanged={onChanged} />
        {autonomy.done.map((d) => (
          <li key={d.key} className={d.ok ? undefined : "failed"}>
            <div>{ownLine(d) ? d.title : d.ok ? `Retried "${d.title}"` : `Could not retry "${d.title}"`}<small>{ownLine(d) ? d.message : d.ok ? `at ${clock(d.at)}` : d.message}</small>
              {d.undo && onUndo && <button type="button" className="desk-btn" onClick={() => onUndo(d.undo ?? "", d.action)}>Undo</button>}
              {d.stop && onStop && <button type="button" className="desk-btn ghost" onClick={() => onStop(d.stop ?? "")}>Stop doing this</button>}
            </div>
          </li>
        ))}
        {autonomy.done.length === 0 && anyOn && <li><div>Nothing yet<small>What the Desk does on its own shows here.</small></div></li>}
        {autonomy.types.map((t) => (
          <li key={t.action}>
            <div>
              {t.label}
              <small>{t.on ? `The Desk does this on its own. ${t.note}` : "The Desk asks you first."}</small>
              <button type="button" className="desk-btn desk-promote" onClick={() => onPromote(t.action, !t.on)}>
                {t.on ? "Stop doing this on your own" : "Handle this yourself"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NotifyHint({ onEnable, onDismiss }: { onEnable: () => void; onDismiss: () => void }) {
  return (
    <p className="desk-hint" role="note">
      See interrupting items while this tab is in the background.
      <button type="button" className="desk-btn ghost" onClick={onEnable}>Turn on notifications</button>
      <button type="button" className="desk-btn ghost" onClick={onDismiss}>Not now</button>
    </p>
  );
}
