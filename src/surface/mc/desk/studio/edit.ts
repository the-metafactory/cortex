import { stringify } from "yaml";
import { NOTE_META_KEYS, sectionKey } from "./format";
import { localDate } from "./labels";

export type FrontValue = string | boolean | undefined;

interface Doc {
  lines: string[];
  frontEnd: number;
}

function toDoc(text: string): Doc | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return close < 0 ? null : { lines, frontEnd: close };
}

const fromDoc = (doc: Doc): string => `${doc.lines.join("\n").replace(/\n+$/, "")}\n`;

export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function scalar(value: string | boolean): string {
  if (typeof value === "boolean") return String(value);
  return stringify(oneLine(value)).trimEnd();
}

const continues = (line: string | undefined): boolean => line !== undefined && /^\s+\S/.test(line);

export function setFront(text: string, key: string, value: FrontValue): string | null {
  const doc = toDoc(text);
  if (!doc) return null;
  const at = doc.lines.findIndex((l, i) => i > 0 && i < doc.frontEnd && l.startsWith(`${key}:`));
  if (at < 0) {
    if (value === undefined) return text;
    doc.lines.splice(doc.frontEnd, 0, `${key}: ${scalar(value)}`);
    return fromDoc(doc);
  }
  let end = at + 1;
  while (end < doc.frontEnd && continues(doc.lines[end])) end++;
  doc.lines.splice(at, end - at, ...(value === undefined ? [] : [`${key}: ${scalar(value)}`]));
  return fromDoc(doc);
}

function findSection(doc: Doc, key: string): { head: number; end: number } | null {
  let head = -1;
  for (let i = doc.frontEnd + 1; i < doc.lines.length; i++) {
    const line = doc.lines[i] ?? "";
    if (!line.startsWith("## ")) continue;
    if (head >= 0) return { head, end: i };
    if (sectionKey(line.slice(3)) === key) head = i;
  }
  return head >= 0 ? { head, end: doc.lines.length } : null;
}

function trimBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && (out[0] ?? "").trim() === "") out.shift();
  while (out.length && (out.at(-1) ?? "").trim() === "") out.pop();
  return out;
}

export function safeBody(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((l) => (/^\s*(#|---)/.test(l) ? `\\${l.trimStart()}` : l));
}

function writeSection(text: string, key: string, heading: string, body: (current: string[]) => string[]): string | null {
  const doc = toDoc(text);
  if (!doc) return null;
  const found = findSection(doc, key);
  if (!found) {
    doc.lines = [...trimBlank(doc.lines), "", `## ${heading}`, "", ...body([])];
    return fromDoc(doc);
  }
  const current = trimBlank(doc.lines.slice(found.head + 1, found.end));
  const next = body(current);
  const tail = found.end < doc.lines.length ? [""] : [];
  doc.lines.splice(found.head + 1, found.end - found.head - 1, "", ...next, ...tail);
  return fromDoc(doc);
}

export const setSection = (text: string, key: string, heading: string, body: string): string | null =>
  writeSection(text, key, heading, () => safeBody(body));

export const appendLog = (text: string, date: string, line: string): string | null =>
  writeSection(text, "log", "Log", (current) => [...current, `- ${date}: ${oneLine(line)}`]);

export const appendEntry = (text: string, key: string, heading: string, entry: string[]): string | null =>
  writeSection(text, key, heading, (current) => [...current, ...(current.length ? [""] : []), ...entry]);

const META = new RegExp(`^(${NOTE_META_KEYS.join("|")}):`);

function noteDoc(text: string, at: string): { doc: Doc; head: number; end: number } | null {
  const doc = toDoc(text);
  const notes = doc ? findSection(doc, "notes") : null;
  if (!doc || !notes) return null;
  const head = doc.lines.findIndex((l, i) => i > notes.head && i < notes.end && l.startsWith("### ") && l.slice(4).trim() === at);
  return head < 0 ? null : { doc, head, end: notes.end };
}

export function setNoteStatus(text: string, at: string, status: string): string | null {
  const found = noteDoc(text, at);
  if (!found) return null;
  const { doc, head, end } = found;
  let i = head + 1;
  let statusAt = -1;
  for (; i < end && META.test(doc.lines[i] ?? ""); i++) if ((doc.lines[i] ?? "").startsWith("status:")) statusAt = i;
  if (statusAt >= 0) doc.lines[statusAt] = `status: ${status}`;
  else doc.lines.splice(i, 0, `status: ${status}`);
  return fromDoc(doc);
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function localTime(at: Date): string {
  const off = -at.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${localDate(at)}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function setNoteText(text: string, at: string, body: string): string | null {
  const found = noteDoc(text, at);
  if (!found) return null;
  const { doc, head, end: limit } = found;
  let start = head + 1;
  while (start < limit && META.test(doc.lines[start] ?? "")) start++;
  let end = start;
  while (end < limit && !(doc.lines[end] ?? "").startsWith("### ")) end++;
  doc.lines.splice(start, end - start, "", ...safeBody(body), "");
  return fromDoc(doc);
}
