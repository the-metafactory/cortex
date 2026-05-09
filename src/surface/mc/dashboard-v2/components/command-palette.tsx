/**
 * ⌘K command palette.
 *
 * Open/close is owned by the parent (App). This component only renders
 * the modal when `open` is true. Fuzzy-ish substring filter, keyboard
 * nav (↑↓ select, Enter run, Esc close), mouse hover updates selection.
 *
 * Real commands are wired in by the parent — MIG-1 ships with two stubs
 * (toggle-theme, show-help). MIG-2…MIG-5 add jump-to-agent /
 * jump-to-card / approve / deny / etc.
 *
 * CSS lives in styles/global.css under .cmdk / .cmdk-bg / .cmdk-list /
 * .cmdk-item / .cmdk-grp / .cmdk-empty.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { KeySeq } from "./keycap";

export interface Command {
  id: string;
  group: string;
  label: string;
  /** Optional keyboard hint rendered as a KeySeq on the right side. */
  keys?: string[];
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset query + selection on each open; focus input async so the modal
  // is mounted before the focus call.
  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      const t = setTimeout(() => inputRef.current?.focus(), 10);
      return () => clearTimeout(t);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.group ?? ""}`.toLowerCase().includes(s)
    );
  }, [q, commands]);

  // Reset selection when filter changes — bias toward the top result.
  useEffect(() => { setIdx(0); }, [q]);

  if (!open) return null;

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[idx];
      if (cmd) {
        cmd.run();
        onClose();
      }
    }
  }

  return (
    <div className="cmdk-bg" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Run a command, jump to an agent, open a task…"
          aria-label="Command search"
        />
        <div className="cmdk-list">
          {filtered.length === 0 && (
            <div className="cmdk-empty">no matches</div>
          )}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`cmdk-item${i === idx ? " active" : ""}`}
              onClick={() => { c.run(); onClose(); }}
              onMouseEnter={() => setIdx(i)}
            >
              <div className="cmdk-l">
                <span className="cmdk-grp">{c.group}</span>
                <span className="truncate">{c.label}</span>
              </div>
              {c.keys && <KeySeq keys={c.keys} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
