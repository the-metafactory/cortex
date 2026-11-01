import { useCallback, useEffect, useState } from "react";

export interface BalanceLocation { tab: "plan" | "review"; item: string | null; area: string; query: string }
export function readBalanceLocation(search: string): BalanceLocation {
  const params = new URLSearchParams(search);
  return { tab: params.get("balance") === "review" || params.get("desk") === "mirror" ? "review" : "plan", item: params.get("balance-item"), area: params.get("balance-area") ?? "", query: params.get("balance-search") ?? "" };
}
export function balanceSearch(search: string, location: BalanceLocation): string {
  const params = new URLSearchParams(search);
  params.set("desk", "balance");
  for (const key of ["thread", "balance", "balance-item", "balance-area", "balance-search"]) params.delete(key);
  if (location.tab === "review") params.set("balance", "review");
  if (location.item) params.set("balance-item", location.item);
  if (location.area) params.set("balance-area", location.area);
  if (location.query) params.set("balance-search", location.query);
  return `?${params.toString()}`;
}
export function balanceItemSearch(search: string, item: string): string {
  return balanceSearch(search, { tab: "plan", item, area: "", query: "" });
}
export function useBalanceLocation(): [BalanceLocation, (next: BalanceLocation, replace?: boolean) => void] {
  const search = typeof window === "undefined" ? "" : window.location.search;
  const [location, setLocation] = useState(() => readBalanceLocation(search));
  useEffect(() => setLocation(readBalanceLocation(search)), [search]);
  useEffect(() => {
    const read = (): void => setLocation(readBalanceLocation(window.location.search));
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const go = useCallback((next: BalanceLocation, replace = false) => {
    const url = `${window.location.pathname}${balanceSearch(window.location.search, next)}${window.location.hash}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    setLocation(next);
  }, []);
  return [location, go];
}
