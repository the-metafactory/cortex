import { useEffect, useMemo, useState } from "react";
import { StudioForegroundClock, type ForegroundReading } from "../lib/studio-foreground";

export function useStudioForeground(inStudio: boolean, timeZone: string | undefined): ForegroundReading {
  const clock = useMemo(() => {
    try { return new StudioForegroundClock(typeof window === "undefined" ? null : window.localStorage, timeZone); }
    catch { return new StudioForegroundClock(null, timeZone); }
  }, [timeZone]);
  const [state, setState] = useState(() => ({ clock, reading: clock.read() }));
  useEffect(() => {
    const sample = (active = inStudio && document.visibilityState === "visible" && document.hasFocus()): void => {
      setState({ clock, reading: clock.sample({ at: Date.now(), monotonic: performance.now(), active }) });
    };
    const changed = (): void => sample();
    const leaving = (): void => sample(false);
    changed();
    const timer = setInterval(changed, 1000);
    window.addEventListener("focus", changed);
    window.addEventListener("blur", leaving);
    window.addEventListener("pagehide", leaving);
    window.addEventListener("storage", changed);
    document.addEventListener("visibilitychange", changed);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", changed);
      window.removeEventListener("blur", leaving);
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("storage", changed);
      document.removeEventListener("visibilitychange", changed);
      leaving();
    };
  }, [clock, inStudio]);
  return state.clock === clock ? state.reading : clock.read();
}
