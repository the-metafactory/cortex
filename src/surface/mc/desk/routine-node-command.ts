export function expandNodeCommand(argv: string[], ref: string, map: string): string[] | null {
  const at = ref.lastIndexOf("#");
  const repo = ref.slice(0, at);
  const id = ref.slice(at + 1);
  if (at <= 0 || !/^[1-9]\d*$/.test(id)) return null;
  const values: Record<string, string> = { ref, repo, id, map };
  return argv.map((arg) => arg.replaceAll(/\{(ref|repo|id|map)\}/g, (_match, key: string) => values[key] ?? ""));
}
