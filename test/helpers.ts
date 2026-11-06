// Test fixtures: a hub with a fake clock, captured outbound HTTP, a Telegram room and five agents.
import { handle } from "../src/app";
import { buildHub } from "../src/build";
import { MemoryStore } from "../src/core/memory-store";
import type { Store } from "../src/core/store";
import type { Agent } from "../src/core/types";
import { D1Store } from "../src/d1/d1-store";
import { d1 } from "./d1-shim";

export const ADMIN = "admin-key-for-tests-0123456789";
export const OWNER_TG = "1001";
export const CHAT = "-500";

export interface Call { url: string; body: any; headers: Record<string, string> }

export const stores: [string, () => Store][] = [["memory", () => new MemoryStore()], ["d1", () => new D1Store(d1())]];

export async function setup(store: Store = new MemoryStore(), vars: Record<string, string> = {}) {
  const clock = { t: Date.parse("2026-11-06T00:00:00Z") };
  const calls: Call[] = [];
  let tgId = 9000;
  const respond: { status: number } = { status: 200 };
  const fileHost: Record<string, string> = {}; // url -> body served by the fake internet
  const failMethods = new Set<string>(); // Telegram methods that answer an error
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: any;
    if (init?.body instanceof FormData) {
      body = {};
      for (const [k, v] of init.body.entries()) body[k] = typeof v === "string" ? v : { blob: true, name: (v as File).name, type: v.type, size: v.size };
    } else {
      const raw = String(init?.body ?? "");
      body = raw;
      try { body = JSON.parse(raw); } catch { /* text body */ }
    }
    calls.push({ url, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (fileHost[url]) return new Response(fileHost[url], { headers: { "content-type": "image/png" } });
    if (url.startsWith("https://api.telegram.org/file/")) return new Response("TGBYTES", { headers: { "content-type": "application/octet-stream", "content-length": "7" } });
    if (url.startsWith("https://api.telegram.org/")) {
      const method = url.split("/").pop()!;
      if (failMethods.has(method)) return Response.json({ ok: false, description: "Bad Request: wrong file identifier/HTTP URL specified" }, { status: 400 });
      if (method === "getFile") return Response.json({ ok: true, result: { file_id: body.file_id, file_path: "photos/file_1.jpg" } });
      const id = ++tgId;
      const f = { file_id: `F${id}`, file_unique_id: `U${id}`, file_size: 1234 };
      const extra = method === "sendPhoto" ? { photo: [{ ...f, file_id: `S${id}`, width: 90, height: 60 }, { ...f, width: 900, height: 600 }] }
        : method === "sendDocument" ? { document: { ...f, file_name: "x.pdf", mime_type: "application/pdf" } }
        : method === "sendVideo" ? { video: { ...f, width: 640, height: 360, duration: 3, mime_type: "video/mp4" } } : {};
      return Response.json({ ok: true, result: { message_id: id, ...extra } });
    }
    return new Response("{}", { status: respond.status });
  }) as typeof fetch;
  const env = {
    ADMIN_KEY: ADMIN, OWNER_TELEGRAM_ID: OWNER_TG, TELEGRAM_WEBHOOK_SECRET: "tg-secret", TELEGRAM_HUB_TOKEN: "HUBTOKEN",
    TELEGRAM_HUB_USERNAME: "omb_hub_bot", TG_TOKEN_MUSE: "MUSETOKEN", TG_TOKEN_GROK: "GROKTOKEN", CLAUDE_TOKEN: "claude-secret", ...vars,
  };
  const hub = buildHub(store, env, fakeFetch, () => clock.t);
  const deferred: Promise<unknown>[] = [];
  hub.defer = (p) => void deferred.push(p);
  const flush = async () => { while (deferred.length) await deferred.shift(); };

  const agent = (id: string, p: Partial<Agent>): Agent => ({
    id, name: id[0].toUpperCase() + id.slice(1), vendor: "custom", card: { summary: "", skills: [] }, doorbell: { kind: "poll" },
    handles: {}, created_at: "2026-11-06T00:00:00Z", ...p,
  });
  await store.putAgent(agent("muse", { vendor: "meta-muse", doorbell: { kind: "watch" }, handles: { telegram: { username: "muse_omb_bot", token_env: "TG_TOKEN_MUSE" } }, card: { summary: "research and writing", skills: ["research"] } }));
  await store.putAgent(agent("grok", { vendor: "grok-bot", doorbell: { kind: "webhook", url: "https://api2.cursor.sh/automations/webhook/x", secret_env: "CLAUDE_TOKEN" }, handles: { telegram: { username: "grok_omb_bot", token_env: "TG_TOKEN_GROK" } }, card: { summary: "news and X search", skills: ["x-search"] } }));
  await store.putAgent(agent("claude", { vendor: "claude-routine", doorbell: { kind: "http", url: "https://api.anthropic.com/v1/claude_code/routines/r1/fire", secret_env: "CLAUDE_TOKEN" }, card: { summary: "code", skills: ["coding"] } }));
  await store.putAgent(agent("hark", { vendor: "hark", doorbell: { kind: "poll" }, card: { summary: "personal concierge", skills: ["booking"] } }));
  await store.putAgent(agent("wabi", { vendor: "wabi", doorbell: { kind: "ntfy", topic: "omb-test" } }));
  await store.putRoom({ id: "main", name: "Main", channel: "telegram", external_id: CHAT, members: ["muse", "grok", "claude", "hark"] });
  const keys: Record<string, string> = {};
  for (const id of ["muse", "grok", "claude", "hark", "wabi"]) keys[id] = await hub.mintKey(id);

  const http = (method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    handle(hub, new Request(`https://hub.test${path}`, {
      method, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      headers: { ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), "content-type": "application/json", ...opts.headers },
    }), { adminKey: ADMIN });
  const op = async (who: string, name: string, body: unknown = {}) => {
    const r = await http("POST", `/v1/${name}`, { key: who === "owner" ? ADMIN : keys[who], body });
    return { status: r.status, json: (await r.json()) as any };
  };
  let upd = 1;
  const tgUpdate = (text: string, extra: Record<string, unknown> = {}, from = OWNER_TG) =>
    http("POST", "/channels/telegram/webhook", {
      headers: { "x-telegram-bot-api-secret-token": "tg-secret" },
      body: { update_id: upd++, message: { message_id: 100 + upd, from: { id: Number(from), username: "me" }, chat: { id: Number(CHAT), type: "supergroup" }, text, ...extra } },
    });
  return { hub, store, clock, calls, respond, keys, http, op, tgUpdate, flush, fileHost, failMethods };
}
