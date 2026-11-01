import { useCallback, useEffect, useState } from "react";

export const SETTINGS_GROUPS = [
  { id: "calendars", label: "Calendars" },
  { id: "vips", label: "VIPs" },
  { id: "unimportant", label: "Unimportant senders" },
  { id: "notifications", label: "Notifications" },
  { id: "mail-sorting", label: "Mail sorting" },
  { id: "mail-rules", label: "Mail rules" },
] as const;

export type SettingsGroup = typeof SETTINGS_GROUPS[number]["id"];

export function readSettingsGroup(search: string): SettingsGroup | null {
  const value = new URLSearchParams(search).get("settings");
  if (value === null) return null;
  return SETTINGS_GROUPS.find((group) => group.id === value)?.id ?? "calendars";
}

export function settingsSearch(search: string, group: SettingsGroup | null): string {
  const params = new URLSearchParams(search);
  if (group === null) params.delete("settings");
  else params.set("settings", group);
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function useSettingsLocation(): [SettingsGroup | null, (group: SettingsGroup | null) => void] {
  const [group, setGroup] = useState(() => readSettingsGroup(typeof window === "undefined" ? "" : window.location.search));
  useEffect(() => {
    const onPop = (): void => { setGroup(readSettingsGroup(window.location.search)); };
    window.addEventListener("popstate", onPop);
    return () => { window.removeEventListener("popstate", onPop); };
  }, []);
  const go = useCallback((next: SettingsGroup | null): void => {
    const search = settingsSearch(window.location.search, next);
    window.history.pushState(null, "", `${window.location.pathname}${search}${window.location.hash}`);
    setGroup(next);
  }, []);
  return [group, go];
}
