// Shared outbound POST for doorbells: https only (plain http just for localhost), no redirects, 15 s timeout.
import type { HubEnv, RingResult } from "../core/plugins";
import type { DoorbellConfig } from "../core/types";

export function destination(cfg: DoorbellConfig): URL {
  if (!cfg.url) throw new Error("doorbell has no url");
  const u = new URL(cfg.url);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("doorbell url must be https");
  return u;
}

export function bearer(cfg: DoorbellConfig, env: HubEnv): Record<string, string> {
  if (!cfg.secret_env) return {};
  const s = env.secret(cfg.secret_env);
  if (!s) throw new Error(`secret ${cfg.secret_env} is not set`);
  return { authorization: `Bearer ${s}` };
}

export async function post(env: HubEnv, url: URL | string, headers: Record<string, string>, body: string): Promise<RingResult> {
  const res = await env.fetch(String(url), { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, detail: `http ${res.status}` };
}
