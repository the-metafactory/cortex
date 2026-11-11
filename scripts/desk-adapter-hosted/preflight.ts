import { parse as parseYaml } from "yaml";

export interface HostedProbeConfig {
  hostname: string;
  localPort: number;
  clientId: string;
  clientSecret: string;
  tunnelToken: string;
}

export type Preflight = { ok: true; config: HostedProbeConfig } | { ok: false; reason: string };

export interface PreflightInput {
  rawConfig: string | undefined;
  target: string | undefined;
  now: Date;
}

const REQUIRED_KEYS = ["hostname", "local_port", "access_client_id", "access_client_secret", "tunnel_token"] as const;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const refuse = (reason: string): Preflight => ({ ok: false, reason });

export function preflight({ rawConfig, target, now }: PreflightInput): Preflight {
  if (rawConfig === undefined) return refuse("the operator configuration for the hosted probe was not found");
  let parsed: unknown;
  try {
    parsed = parseYaml(rawConfig);
  } catch (_err) {
    return refuse("the operator configuration for the hosted probe is not valid YAML");
  }
  if (typeof parsed !== "object" || parsed === null) return refuse("the operator configuration for the hosted probe is empty");
  const values = parsed as Record<string, unknown>;
  const tokenKeys = ["access_client_id", "access_client_secret"];
  if (tokenKeys.some(key => typeof values[key] !== "string" || values[key] === "")) return refuse("no Cloudflare Access service token is configured");
  const missing = REQUIRED_KEYS.filter(key => values[key] === undefined || values[key] === "");
  if (missing.length > 0) return refuse(`the operator configuration lacks: ${missing.join(", ")}`);
  const expires = values["access_token_expires_at"];
  if (expires !== undefined) {
    const at = new Date(String(expires));
    if (Number.isNaN(at.getTime())) return refuse("access_token_expires_at is not a date");
    if (at.getTime() <= now.getTime()) return refuse("the Cloudflare Access service token has expired");
  }
  const hostname = String(values["hostname"]).toLowerCase();
  if (!HOSTNAME.test(hostname)) return refuse("the configured hostname is not a plain DNS name");
  const port = Number(values["local_port"]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return refuse("local_port must be an unprivileged port");
  if (target !== undefined && target.toLowerCase() !== hostname) return refuse("the target is not the configured disposable stack; nothing was sent");
  return { ok: true, config: { hostname, localPort: port, clientId: String(values["access_client_id"]), clientSecret: String(values["access_client_secret"]), tunnelToken: String(values["tunnel_token"]) } };
}

export function redactor(config: HostedProbeConfig): (text: string) => string {
  const secrets = [config.hostname, config.clientId, config.clientSecret, config.tunnelToken].filter(value => value.length > 0);
  return text => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}
