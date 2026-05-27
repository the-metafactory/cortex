/**
 * Linear-style keycap chip + sequence helper.
 *
 * Used in the command palette, inline help, and principal-shortcut hints.
 * CSS lives in styles/global.css under .kc / .kc-seq.
 */

import { Fragment, type ReactNode } from "react";

export interface KeycapProps {
  children: ReactNode;
}

export function Keycap({ children }: KeycapProps) {
  return <kbd className="kc">{children}</kbd>;
}

export interface KeySeqProps {
  /** Each entry renders as a Keycap; entries are joined with a `+` separator. */
  keys: ReactNode[];
}

export function KeySeq({ keys }: KeySeqProps) {
  return (
    <span className="kc-seq">
      {keys.map((k, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="kc-sep">+</span>}
          <Keycap>{k}</Keycap>
        </Fragment>
      ))}
    </span>
  );
}
