export function usesListenerPort(conf: string, ports: readonly number[]): boolean {
  return ports.some(port => new RegExp(`(?:^|[\\s{,])(?:listen|port|https?)\\s*[:=]\\s*["']?(?:[^"'\\s{}]*:)?${port}(?=["'\\s,}]|$)`, "m").test(conf));
}
