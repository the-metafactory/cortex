import { useCallback, useRef, useState } from "react";
import type { StudioAct } from "../../desk/studio/acts";
import type { StudioView } from "../../desk/studio/view";
import { submitStudioAct, type StudioActOutcome } from "../lib/desk-action";

export interface StudioActs {
  pending: boolean;
  note: { ok: boolean; text: string } | null;
  send: (act: StudioAct) => Promise<StudioActOutcome>;
}

type Submit = typeof submitStudioAct;

const newId = (): string => globalThis.crypto.randomUUID();

export function requestIdFor(last: { key: string; id: string } | null, key: string, make: () => string = newId): string {
  return last?.key === key ? last.id : make();
}

export function useStudioActs(onStudio: (view: StudioView) => void, submit: Submit = submitStudioAct): StudioActs {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<StudioActs["note"]>(null);
  const unsure = useRef<{ key: string; id: string } | null>(null);
  const busy = useRef(false);

  const send = useCallback(
    async (act: StudioAct): Promise<StudioActOutcome> => {
      if (busy.current) return { ok: false, text: "Another change is on its way." };
      busy.current = true;
      setPending(true);
      const key = JSON.stringify(act);
      const requestId = requestIdFor(unsure.current, key);
      try {
        const out = await submit({ ...act, requestId });
        unsure.current = out.uncertain ? { key, id: requestId } : null;
        if (out.studio) onStudio(out.studio);
        setNote({ ok: out.ok, text: out.text });
        return out;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [onStudio, submit],
  );

  return { pending, note, send };
}
