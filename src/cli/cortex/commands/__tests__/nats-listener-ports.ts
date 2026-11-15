export function usesListenerPort(conf: string, ports: readonly number[]): boolean {
  return ports.some(port => new RegExp(`(?:^|[\\s{,])(?:listen|(?:https?_|monitor_|prof_)?port|https?)\\s*[:=]\\s*["']?(?:[^"'\\s{}]*:)?${port}(?=["'\\s,}]|$)`, "m").test(conf));
}
