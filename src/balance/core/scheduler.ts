import { required } from "./required";
import { ownValue } from "./record";
import { type AppState, type CompletionEvent, type ContextDef, type NodeId, type OutlineNode, type SchedHistory, type Settings, type TodayItem, FOCUS_BOOST, MAX_TODAY_CAP, } from "./types";
import { contextAllows, contextDefMap, sameContext } from "./contexts";
const EPS = 0.05;
const FACTOR_MIN = 1 / 3;
const FACTOR_MAX = 3;
const EVIDENCE_K = 2;
const URGENCY_MAX = 3;
const MUST_PLACE_URGENCY = 2;
export function daysBetween(fromIso: string, toIso: string): number {
    const from = Date.parse(fromIso + "T00:00:00Z");
    const to = Date.parse(toIso + "T00:00:00Z");
    return Math.round((to - from) / 86400000);
}
export function monthOf(dateIso: string): string {
    return dateIso.slice(0, 7);
}
export function isSubtreeDone(node: OutlineNode): boolean {
    if (node.done === true)
        return true;
    if (node.children.length === 0)
        return false;
    return node.children.every(isSubtreeDone);
}
export function collectLeaves(node: OutlineNode): OutlineNode[] {
    if (node.children.length === 0)
        return [node];
    return node.children.flatMap(collectLeaves);
}
export function findNode(root: OutlineNode, id: NodeId): OutlineNode | null {
    if (root.id === id)
        return root;
    for (const child of root.children) {
        const hit = findNode(child, id);
        if (hit)
            return hit;
    }
    return null;
}
export function ancestorIndex(root: OutlineNode): Map<NodeId, OutlineNode[]> {
    const index = new Map<NodeId, OutlineNode[]>();
    const walk = (node: OutlineNode, ancestors: OutlineNode[]) => {
        index.set(node.id, ancestors);
        for (const child of node.children)
            walk(child, [...ancestors, node]);
    };
    walk(root, []);
    return index;
}
function taskBlockedByDates(task: OutlineNode, today: string): boolean {
    if (task.startDate && task.startDate > today)
        return true;
    if (task.deferredUntil && task.deferredUntil > today)
        return true;
    return false;
}
export interface Candidate {
    task: OutlineNode;
    areaId: NodeId;
    areaTitle: string;
    path: string[];
    ctx?: string;
}
export function availableTasks(root: OutlineNode, today: string, activeContext?: string | null, contexts: ContextDef[] = [], timeNow?: string): Candidate[] {
    const out: Candidate[] = [];
    const defs = contextDefMap(contexts);
    const walkArea = (area: OutlineNode) => {
        const walk = (node: OutlineNode, path: string[], inheritedCtx?: string) => {
            const ctx = node.context ?? inheritedCtx;
            if (node.children.length === 0) {
                if (activeContext && ctx && !sameContext(ctx, activeContext))
                    return;
                if (!contextAllows(ctx, activeContext, defs, today, timeNow))
                    return;
                if (!node.done && !taskBlockedByDates(node, today)) {
                    out.push({ task: node, areaId: area.id, areaTitle: area.title, path, ctx });
                }
                return;
            }
            if (node.done)
                return;
            if (taskBlockedByDates(node, today))
                return;
            const childPath = node === area ? path : [...path, node.title];
            if (node.ordering === "sequential") {
                for (const child of node.children) {
                    if (isSubtreeDone(child))
                        continue;
                    if (child.weight === 0)
                        continue;
                    walk(child, node === area ? [] : childPath, ctx);
                    return;
                }
            }
            else {
                for (const child of node.children) {
                    if (child.weight === 0)
                        continue;
                    walk(child, node === area ? [] : childPath, ctx);
                }
            }
        };
        walk(area, []);
    };
    for (const area of root.children) {
        if (area.weight === 0)
            continue;
        if (area.children.length === 0)
            continue;
        walkArea(area);
    }
    return out;
}
export function creditIndex(root: OutlineNode, log: CompletionEvent[], today: string, halfLifeDays: number): Map<NodeId, number> {
    const ancestors = ancestorIndex(root);
    const credits = new Map<NodeId, number>();
    const add = (id: NodeId, amount: number) => {
        credits.set(id, (credits.get(id) ?? 0) + amount);
    };
    for (const event of log) {
        const age = daysBetween(event.date, today);
        if (age < 0)
            continue;
        if (age > 8 * halfLifeDays)
            continue;
        const value = (1 + 0.5 * event.effort) * Math.pow(0.5, age / halfLifeDays);
        const anchorId = ancestors.has(event.taskId) ? event.taskId : event.areaId;
        const chain = ancestors.get(anchorId);
        if (chain === undefined)
            continue;
        add(anchorId, value);
        for (const node of chain)
            add(node.id, value);
    }
    return credits;
}
function clamp(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x));
}
export function focusContainment(root: OutlineNode, month: string): Set<NodeId> {
    const containing = new Set<NodeId>();
    const walk = (node: OutlineNode): boolean => {
        let contains = node.focusMonth === month;
        for (const child of node.children) {
            if (walk(child))
                contains = true;
        }
        if (contains)
            containing.add(node.id);
        return contains;
    };
    walk(root);
    return containing;
}
export function effectiveShares(root: OutlineNode, log: CompletionEvent[], today: string, settings: Settings): Map<NodeId, number> {
    const credits = creditIndex(root, log, today, settings.halfLifeDays);
    const month = monthOf(today);
    const focusIds = focusContainment(root, month);
    const shares = new Map<NodeId, number>();
    shares.set(root.id, 1);
    const walk = (node: OutlineNode) => {
        const parentShare = shares.get(node.id) ?? 0;
        const active = node.children.filter((c) => c.weight > 0);
        for (const child of node.children) {
            if (child.weight <= 0)
                shares.set(child.id, 0);
        }
        if (active.length > 0) {
            const staticWeights = active.map((c) => c.weight * (focusIds.has(c.id) ? FOCUS_BOOST : 1));
            const staticTotal = staticWeights.reduce((a, b) => a + b, 0);
            const targets = staticWeights.map((w) => w / staticTotal);
            const rawCredits = active.map((c) => credits.get(c.id) ?? 0);
            const creditTotal = rawCredits.reduce((a, b) => a + b, 0);
            const confidence = creditTotal / (creditTotal + EVIDENCE_K);
            const adjusted = active.map((_, i) => {
                const target = required(targets[i]);
                const rawShare = creditTotal > 0 ? required(rawCredits[i]) / creditTotal : target;
                const actual = confidence * rawShare + (1 - confidence) * target;
                const factor = clamp(Math.pow((target + EPS) / (actual + EPS), settings.balanceBeta), FACTOR_MIN, FACTOR_MAX);
                return required(staticWeights[i]) * factor;
            });
            const adjustedTotal = adjusted.reduce((a, b) => a + b, 0);
            active.forEach((activeChild, i) => {
                shares.set(activeChild.id, parentShare * (required(adjusted[i]) / adjustedTotal));
            });
        }
        for (const child of node.children)
            walk(child);
    };
    walk(root);
    return shares;
}
export function urgencyOf(task: OutlineNode, today: string): number {
    if (!task.dueDate)
        return 1;
    const lead = task.leadDays ?? 7;
    const daysLeft = daysBetween(today, task.dueDate);
    if (daysLeft <= 0)
        return URGENCY_MAX;
    if (daysLeft >= lead || lead <= 0)
        return 1;
    return 1 + (URGENCY_MAX - 1) * ((lead - daysLeft) / lead);
}
export function allocateSlots(weights: Map<string, number>, slots: number, deficits: Record<string, number> = {}): Map<string, number> {
    const entries = [...weights.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    const result = new Map<string, number>();
    for (const [key] of entries)
        result.set(key, 0);
    if (total <= 0 || slots <= 0 || entries.length === 0)
        return result;
    const entitlement = new Map<string, number>();
    for (const [key, w] of entries) {
        entitlement.set(key, (w / total) * slots + (ownValue(deficits, key) ?? 0));
    }
    for (let s = 0; s < slots; s++) {
        let best: string | null = null;
        let bestValue = -Infinity;
        for (const [key, value] of entitlement) {
            if (value > bestValue || (value === bestValue && best !== null && key < best)) {
                best = key;
                bestValue = value;
            }
        }
        if (best === null)
            break;
        result.set(best, (result.get(best) ?? 0) + 1);
        entitlement.set(best, bestValue - 1);
    }
    return result;
}
export function areaQuotas(weights: Map<string, number>, slots: number): Map<string, number> {
    const total = [...weights.values()].reduce((a, b) => a + b, 0);
    const quotas = new Map<string, number>();
    for (const [key, w] of weights) {
        quotas.set(key, total > 0 && slots > 0 ? (w / total) * slots : 0);
    }
    return quotas;
}
function byScoreThenId(a: ScoredCandidate, b: ScoredCandidate): number {
    if (b.score !== a.score)
        return b.score - a.score;
    return a.task.id < b.task.id ? -1 : 1;
}
interface ScoredCandidate extends Candidate {
    score: number;
    urgency: number;
    focus: boolean;
}
interface SelectionContext {
    items: TodayItem[];
    areaWeights: Map<string, number>;
    balancedSlots: number;
}
function byDueThenId(a: ScoredCandidate, b: ScoredCandidate): number {
    const da = a.task.dueDate ?? "9999-12-31";
    const db = b.task.dueDate ?? "9999-12-31";
    if (da !== db)
        return da < db ? -1 : 1;
    return a.task.id < b.task.id ? -1 : 1;
}
function agingOf(taskId: NodeId, history: SchedHistory, today: string): number {
    const seen = ownValue(history.lastSurfaced, taskId) ?? history.startDate;
    if (!seen)
        return 1;
    return 1 + Math.max(0, daysBetween(seen, today)) / 14;
}
const MAX_RANK_AGING = 3;
function isReEntry(log: CompletionEvent[], today: string): boolean {
    if (log.length === 0)
        return false;
    return !log.some((e) => {
        const age = daysBetween(e.date, today);
        return age >= 0 && age < 7;
    });
}
export interface SelectOptions {
    benchMode?: boolean;
    timeNow?: string;
}
export function selectToday(state: AppState, today: string, opts: SelectOptions = {}): TodayItem[] {
    return selectTodayFull(state, today, opts).items;
}
function selectTodayFull(state: AppState, today: string, opts: SelectOptions = {}): SelectionContext {
    const { outline, log, settings, history } = state;
    const timeNow = opts.timeNow;
    let cap = clamp(Math.floor(settings.todayCap), 1, MAX_TODAY_CAP);
    if (!opts.benchMode && isReEntry(log, today))
        cap = Math.min(cap, 3);
    const shares = effectiveShares(outline, log, today, settings);
    const month = monthOf(today);
    const candidates = scoreCandidates(state, today, timeNow, shares);
    const picked: ScoredCandidate[] = [];
    const pickedIds = new Set<NodeId>();
    const place = (c: ScoredCandidate) => {
        picked.push(c);
        pickedIds.add(c.task.id);
    };
    const dueSoon = candidates
        .filter((c) => c.urgency >= MUST_PLACE_URGENCY)
        .sort(byDueThenId);
    const hasNonDue = candidates.some((c) => c.urgency < MUST_PLACE_URGENCY);
    const dueLimit = hasNonDue && cap > 1 ? cap - 1 : cap;
    for (const c of dueSoon) {
        if (picked.length >= dueLimit)
            break;
        place(c);
    }
    const open = () => candidates.filter((c) => !pickedIds.has(c.task.id));
    const areaWeights = new Map<string, number>();
    for (const c of candidates) {
        areaWeights.set(c.areaId, Math.max(areaWeights.get(c.areaId) ?? 0, shares.get(c.areaId) ?? 0));
    }
    const balancedSlots = Math.max(0, cap - picked.length);
    if (balancedSlots > 0) {
        const slots = allocateSlots(areaWeights, balancedSlots, history.deficits);
        for (const [areaId, count] of [...slots.entries()].sort()) {
            const areaOpen = open()
                .filter((c) => c.areaId === areaId)
                .sort(byScoreThenId);
            for (const c of areaOpen.slice(0, count))
                place(c);
        }
    }
    for (const c of open().sort(byScoreThenId)) {
        if (picked.length >= cap)
            break;
        place(c);
    }
    let ordered = [
        ...picked.filter((c) => c.urgency >= MUST_PLACE_URGENCY).sort(byDueThenId),
        ...picked.filter((c) => c.urgency < MUST_PLACE_URGENCY).sort(byScoreThenId),
    ].slice(0, cap);
    if (!opts.benchMode && settings.emergencyMode && ordered.length > 1) {
        const easiest = required([...ordered.slice(0, 5)].sort((a, b) => {
            const ea = a.task.effort ?? 1;
            const eb = b.task.effort ?? 1;
            if (ea !== eb)
                return ea - eb;
            return ordered.indexOf(a) - ordered.indexOf(b);
        })[0]);
        ordered = [easiest];
    }
    const areaTargets = targetAreaShares(outline, month);
    const items = todayItems(ordered, shares, areaTargets);
    const offeredBalanced = items.filter((i) => i.reason !== "due").length;
    return { items, areaWeights, balancedSlots: Math.min(balancedSlots, offeredBalanced) };
}
function targetAreaShares(outline: OutlineNode, month: string): Map<NodeId, number> {
    const focusIds = focusContainment(outline, month);
    const active = outline.children.filter((a) => a.weight > 0);
    const weights = active.map((a) => a.weight * (focusIds.has(a.id) ? FOCUS_BOOST : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    const map = new Map<NodeId, number>();
    active.forEach((a, i) => map.set(a.id, total > 0 ? required(weights[i]) / total : 0));
    return map;
}
function traceFor(c: ScoredCandidate, reason: TodayItem["reason"], shares: Map<NodeId, number>, targets: Map<NodeId, number>): string {
    if (reason === "due") {
        return c.task.dueDate ? `due ${c.task.dueDate}` : "deadline approaching";
    }
    if (reason === "focus")
        return "part of this month's focus";
    const actual = shares.get(c.areaId) ?? 0;
    const target = targets.get(c.areaId) ?? 0;
    if (actual > target * 1.15)
        return `${c.areaTitle} has been quiet lately — catching up`;
    return `keeps ${c.areaTitle} moving`;
}
function scoreCandidates(
    state: AppState,
    today: string,
    timeNow: string | undefined,
    shares: Map<NodeId, number>,
    agingLimit = Infinity,
): ScoredCandidate[] {
    const { outline, settings, history } = state;
    const month = monthOf(today);
    const ancestors = ancestorIndex(outline);
    return availableTasks(outline, today, settings.activeContext, state.contexts ?? [], timeNow)
        .map((c) => {
            const share = shares.get(c.task.id) ?? 0;
            const urgency = urgencyOf(c.task, today);
            const focus = (ancestors.get(c.task.id) ?? []).some((a) => a.focusMonth === month) || c.task.focusMonth === month;
            const aging = Math.min(agingOf(c.task.id, history, today), agingLimit);
            return { ...c, urgency, score: share * urgency * aging, focus };
        })
        .filter((c) => (shares.get(c.task.id) ?? 0) > 0);
}
function todayItems(ordered: ScoredCandidate[], shares: Map<NodeId, number>, areaTargets: Map<NodeId, number>): TodayItem[] {
    return ordered.map((c) => {
        const reason: TodayItem["reason"] = c.urgency >= MUST_PLACE_URGENCY ? "due" : c.focus ? "focus" : "balance";
        return {
            task: c.task,
            areaId: c.areaId,
            areaTitle: c.areaTitle,
            path: c.path,
            context: c.ctx,
            score: c.score,
            urgency: c.urgency,
            reason,
            trace: traceFor(c, reason, shares, areaTargets),
        };
    });
}
export function rankAll(state: AppState, today: string, timeNow?: string): TodayItem[] {
    const { outline, log, settings } = state;
    const shares = effectiveShares(outline, log, today, settings);
    const month = monthOf(today);
    const candidates = scoreCandidates(state, today, timeNow, shares, MAX_RANK_AGING);
    const ordered = [
        ...candidates.filter((c) => c.urgency >= MUST_PLACE_URGENCY).sort(byDueThenId),
        ...candidates.filter((c) => c.urgency < MUST_PLACE_URGENCY).sort(byScoreThenId),
    ];
    const areaTargets = targetAreaShares(outline, month);
    return todayItems(ordered, shares, areaTargets);
}
export function applyDayToHistory(state: AppState, today: string, confirmedIds: NodeId[]): SchedHistory {
    const { history } = state;
    if (history.lastAppliedDate === today)
        return history;
    const { items, areaWeights, balancedSlots } = selectTodayFull(state, today);
    const quotas = areaQuotas(areaWeights, balancedSlots);
    const dueIds = new Set(items.filter((i) => i.reason === "due").map((i) => i.task.id));
    const ancestors = ancestorIndex(state.outline);
    const granted = new Map<string, number>();
    for (const id of confirmedIds) {
        if (dueIds.has(id))
            continue;
        const area = ancestors.get(id)?.[1];
        if (area)
            granted.set(area.id, (granted.get(area.id) ?? 0) + 1);
    }
    const liveAreas = new Set(state.outline.children.map((a) => a.id));
    const deficits = new Map<string, number>();
    for (const [areaId, value] of Object.entries(history.deficits)) {
        if (liveAreas.has(areaId))
            deficits.set(areaId, value);
    }
    for (const [areaId, quota] of quotas) {
        const carried = ownValue(history.deficits, areaId) ?? 0;
        const next = carried + quota - (granted.get(areaId) ?? 0);
        deficits.set(areaId, clamp(next, -3, 3));
    }
    const lastSurfaced = new Map(Object.entries(history.lastSurfaced));
    for (const id of confirmedIds)
        lastSurfaced.set(id, today);
    return {
        startDate: history.startDate ?? today,
        deficits: Object.fromEntries(deficits),
        lastSurfaced: Object.fromEntries(lastSurfaced),
        lastAppliedDate: today,
    };
}
