import { entryBlock } from "./studio/format";

const FILED_CAPTURE = /^- capture: \[(capture-[a-f0-9]{32})\] (.*)$/;

interface FiledCapture {
  id: string;
  text: string;
}

export function captureEntries(threadText: string): FiledCapture[] {
  const lines = threadText.split("\n");
  const found: FiledCapture[] = [];
  for (let at = 0; at < lines.length; at++) {
    const match = FILED_CAPTURE.exec(lines[at] ?? "");
    if (!match) continue;
    const block = entryBlock(lines, at);
    found.push({ id: match[1] ?? "", text: [match[2] ?? "", ...block.slice(1).map((line) => line.trim())].join("\n").trim() });
    at += block.length - 1;
  }
  return found;
}
