import { useState } from "react";

const UNREADABLE_STORAGE_MEANS_OFF = false;
const KEPT_FOR_THIS_PAGE_ONLY = false;

function readFlag(key: string): boolean {
  try { return typeof window !== "undefined" && window.localStorage.getItem(key) === "1"; }
  catch { return UNREADABLE_STORAGE_MEANS_OFF; }
}
function writeFlag(key: string, value: boolean): boolean {
  try { window.localStorage.setItem(key, value ? "1" : "0"); return true; }
  catch { return KEPT_FOR_THIS_PAGE_ONLY; }
}

/** A per-browser on/off preference that survives a reload when local storage is available. */
export function useStoredFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readFlag(key));
  return [value, next => { setValue(next); writeFlag(key, next); }];
}
