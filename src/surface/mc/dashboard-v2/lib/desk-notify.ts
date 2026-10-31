import type { DeskView } from "../../desk/types";
import { freshInterrupts, loadSeen, rememberSeen, type SeenStore } from "./desk-chime";

const NOTIFIED_KEY = "desk.notified";
const HINT_KEY = "desk.notifyHint";

export type NotifyState = "off" | "insecure" | "unsupported" | NotificationPermission;

export interface NotifyApi {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): Pick<Notification, "onclick" | "close">;
}

export interface NotifyEnv {
  api: NotifyApi | null;
  secure: boolean;
  store: SeenStore;
  focus: () => void;
}

export const NOTIFY_LINE: Record<NotifyState, string> = {
  off: "Turned off for this stack (mc.desk.interruptions.notifications: false).",
  insecure: "Browsers show notifications only on https or localhost, and this page is plain http.",
  unsupported: "This browser does not offer notifications.",
  denied: "This browser blocks notifications for the Desk. Allow them in the site settings, then reload.",
  default: "Show interrupting items as system notifications while the Desk tab is in the background.",
  granted: "On. Interrupting items also show as system notifications.",
};

export function notifyState(enabled: boolean, env: Pick<NotifyEnv, "api" | "secure"> | null): NotifyState {
  if (!enabled) return "off";
  if (!env?.secure) return "insecure";
  if (!env.api) return "unsupported";
  return env.api.permission;
}

export function notifyIfNew(view: DeskView, env: NotifyEnv, open: (key: string) => void): string[] {
  const api = env.api;
  if (!api || notifyState(view.notifications, env) !== "granted") return [];
  const seen = loadSeen(env.store, NOTIFIED_KEY);
  const fresh = freshInterrupts(view, seen);
  if (fresh.length === 0) return [];
  rememberSeen(env.store, NOTIFIED_KEY, seen, fresh);
  const items = new Map(view.items.map((i) => [i.key, i]));
  return fresh.filter((key) => {
    const item = items.get(key);
    if (!item) return false;
    const shown = new api(item.title, { body: item.why, tag: `desk:${key}` });
    shown.onclick = () => {
      env.focus();
      open(key);
      shown.close();
    };
    return true;
  });
}

export async function enableNotifications(view: DeskView, env: NotifyEnv): Promise<NotifyState> {
  env.store.setItem(HINT_KEY, "done");
  if (!env.api || notifyState(view.notifications, env) !== "default") return notifyState(view.notifications, env);
  const permission = await env.api.requestPermission();
  if (permission === "granted") {
    const seen = loadSeen(env.store, NOTIFIED_KEY);
    rememberSeen(env.store, NOTIFIED_KEY, seen, freshInterrupts(view, seen));
  }
  return permission;
}

export function wantsHint(enabled: boolean, env: NotifyEnv | null): boolean {
  return env !== null && notifyState(enabled, env) === "default" && env.store.getItem(HINT_KEY) === null;
}

export function dismissHint(env: NotifyEnv | null): void {
  env?.store.setItem(HINT_KEY, "done");
}

export function browserNotifyEnv(): NotifyEnv | null {
  if (typeof window === "undefined") return null;
  return {
    api: typeof Notification === "undefined" ? null : Notification,
    secure: window.isSecureContext,
    store: window.localStorage,
    focus: () => window.focus(),
  };
}

export function notifyForNew(view: DeskView, open: (key: string) => void): void {
  const env = browserNotifyEnv();
  if (!env) return;
  try {
    notifyIfNew(view, env, open);
  } catch {
    return;
  }
}
