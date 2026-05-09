/**
 * URL-scheme allowlist for operator-imported links rendered in the UI.
 *
 * Iteration source URLs come from upstream issues (GitHub today, Jira /
 * Linear later). Their bodies are operator-imported, so a malicious or
 * compromised upstream could embed a `javascript:` or `data:` URL that
 * would execute on click. Render the anchor only when the URL parses to
 * an `http:` or `https:` scheme; otherwise return `null` and let the
 * caller render the badge without an anchor.
 *
 * Used by F-14 iteration-board cards; F-15 iteration-detail will
 * consume the same helper.
 */
export function safeSourceHref(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return url;
    return null;
  } catch {
    return null;
  }
}
