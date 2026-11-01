import { useCallback, useEffect, useState } from "react";

export type CardFilter = "all" | "action" | "update";
export interface CatchupLocation {
  area: string;
  filter: CardFilter;
  card: string | null;
}
export function readCatchupLocation(search: string): CatchupLocation {
  const params = new URLSearchParams(search);
  const filter = params.get("catchup-type");
  return {
    area: params.get("catchup-area") ?? "",
    filter: filter === "action" || filter === "update" ? filter : "all",
    card: params.get("catchup-card"),
  };
}
export function catchupSearch(search: string, next: CatchupLocation): string {
  const params = new URLSearchParams(search);
  params.set("desk", "catchup");
  for (const key of ["thread", "catchup-area", "catchup-type", "catchup-card"])
    params.delete(key);
  if (next.area) params.set("catchup-area", next.area);
  if (next.filter !== "all") params.set("catchup-type", next.filter);
  if (next.card) params.set("catchup-card", next.card);
  return `?${params.toString()}`;
}
export function useCatchupLocation(): [
  CatchupLocation,
  (next: CatchupLocation) => void,
] {
  const [location, setLocation] = useState(() =>
    readCatchupLocation(
      typeof window === "undefined" ? "" : window.location.search,
    ),
  );
  useEffect(() => {
    const read = (): void =>
      setLocation(readCatchupLocation(window.location.search));
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const go = useCallback((next: CatchupLocation) => {
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${catchupSearch(window.location.search, next)}${window.location.hash}`,
    );
    setLocation(next);
  }, []);
  return [location, go];
}
