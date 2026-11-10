import { useState } from "react";

const KEPT_FOR_THIS_PAGE_ONLY = false;

function readFlag(key: string, defaultValue: boolean): boolean {
  try {
    const stored = typeof window === "undefined" ? null : window.localStorage.getItem(key);
    return stored === null ? defaultValue : stored === "1";
  }
  catch { return defaultValue; }
}
function writeFlag(key: string, value: boolean): boolean {
  try { window.localStorage.setItem(key, value ? "1" : "0"); return true; }
  catch { return KEPT_FOR_THIS_PAGE_ONLY; }
}

/** A per-browser on/off preference that survives a reload when local storage is available. */
export function useStoredFlag(key: string, defaultValue = false): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readFlag(key, defaultValue));
  return [value, next => { setValue(next); writeFlag(key, next); }];
}
