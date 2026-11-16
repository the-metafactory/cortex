import type { LoginView } from "../../../../conversations/codex-auth-contract";
import { getJson, postJson } from "./api";

export type { LoginView };
const BASE = "/api/conversations/codex-auth";

export const readLogin = (): Promise<{ login: LoginView | null }> => getJson(`${BASE}/login`);
export const startLogin = (): Promise<{ login: LoginView }> => postJson(`${BASE}/login`, {});
export const answerLogin = (id: string, answer: string): Promise<{ login: LoginView }> => postJson(`${BASE}/login/input`, { id, answer });
export const cancelLogin = (id: string): Promise<{ login: LoginView }> => postJson(`${BASE}/login/cancel`, { id });

export const ACTIVE_LOGIN: readonly LoginView["state"][] = ["starting", "awaiting-browser", "awaiting-input"];
export const isWebUrl = (value: string | undefined): value is string => value !== undefined && /^https:\/\//i.test(value);
