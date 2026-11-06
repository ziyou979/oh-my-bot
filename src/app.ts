// HTTP router. Platform-free: takes a Hub and a Request, returns a Response. src/index.ts (Workers) and
// scripts/node-server.ts (Node) only build the Hub and call this.
import { z } from "zod";
import type { Hub } from "./core/hub";
import { emptyRing } from "./core/store";
import { HubError, OWNER, type Agent } from "./core/types";
import { iso, safeEqual } from "./core/util";
import { checkSession, clearCookie, cookieValue, mintLogin, sessionCookie, sessionFromLogin } from "./admin/auth";
import { ADMIN_PAGE, LOGIN_FAILED_PAGE } from "./admin/page";
import { handleMcp } from "./ops/mcp";
import { handleRest, openapi } from "./ops/rest";

const DoorbellSchema = z.object({
  kind: z.string().min(1), url: z.string().url().optional(), secret_env: z.string().regex(/^[A-Z0-9_]+$/).optional(),
  topic: z.string().optional(), server: z.string().url().optional(),
});
const AgentSchema = z.object({
  name: z.string().min(1).max(100),
  vendor: z.string().min(1).max(50).default("custom"),
  card: z.object({ summary: z.string().max(1000), skills: z.array(z.string()).max(50), tags: z.array(z.string()).max(50).optional() }).default({ summary: "", skills: [] }),
  doorbell: DoorbellSchema.default({ kind: "poll" }),
  handles: z.record(z.string(), z.object({ username: z.string().min(1), token_env: z.string().regex(/^[A-Z0-9_]+$/).optional() })).default({}),
  aliases: z.array(z.string()).max(10).optional(),
});
const RoomSchema = z.object({ name: z.string().min(1), channel: z.string().min(1), external_id: z.string().min(1), members: z.array(z.string()) });
const TrustSchema = z.record(z.string(), z.array(z.string()));
const AGENT_ID = /^[a-z][a-z0-9-]{1,31}$/;

const json = (v: unknown, status = 200) => Response.json(v, { status });
const html = (body: string, status = 200) => new Response(body, { status, headers: {
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} });

export interface AppOptions { adminKey?: string; allowedOrigins?: string[] }

export async function handle(hub: Hub, req: Request, opt: AppOptions): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (path === "/") return new Response("oh-my-bot hub. REST: /v1/<op> (see /openapi.json). MCP: POST /mcp. Files: GET /files/<message>/<attachment>.\n");
    if (path === "/openapi.json") return json(openapi(url.origin));

    const watch = /^\/watch\/([^/]+)$/.exec(path);
    if (watch && req.method === "GET") {
      const w = await hub.watch(watch[1]);
      return w ? json(w) : json({ error: "not_found" }, 404);
    }

    hub.origin = url.origin;
    const adminKey = opt.adminKey && opt.adminKey.length >= 16 ? opt.adminKey : undefined;
    hub.adminLink = adminKey ? async () => `${url.origin}/admin/login?t=${await mintLogin(adminKey, hub.env.now())}` : undefined;

    // The admin page loads without a key; its data calls below need the owner's session or the admin key.
    if (path === "/admin" && req.method === "GET") return html(ADMIN_PAGE);
    if (path === "/admin/login" && req.method === "GET") {
      const token = adminKey ? await sessionFromLogin(adminKey, url.searchParams.get("t"), hub.env.now(),
        (nonce, expS) => hub.store.useOnce("admin-login:" + nonce, iso(expS * 1000), iso(hub.env.now()))) : null;
      if (!token) return html(LOGIN_FAILED_PAGE, 401);
      return new Response(null, { status: 303, headers: { location: "/admin", "set-cookie": sessionCookie(token), "cache-control": "no-store" } });
    }
    if (path === "/admin/logout" && req.method === "POST") return new Response(null, { status: 204, headers: { "set-cookie": clearCookie() } });
    const file = /^\/files\/(msg_[a-f0-9]+)\/([a-z0-9]+)$/.exec(path);
    if (file && req.method === "GET") {
      // A signed link (from check_work) works without a key; otherwise the bearer key decides who is asking.
      const q = url.searchParams;
      const signedAs = q.get("sig") && q.get("a") && (await hub.checkFileSig(q.get("a")!, file[1], file[2], q.get("exp") ?? "", q.get("sig")!)) ? q.get("a")! : null;
      const who = signedAs ?? (await principal(hub, req, opt));
      if (!who) return json({ error: "unauthorized", message: "link expired or invalid; get a fresh one with get_file" }, 401);
      return await hub.openFile(who, file[1], file[2]);
    }

    const ch = /^\/channels\/([a-z0-9-]+)\/webhook$/.exec(path);
    if (ch && req.method === "POST") {
      const adapter = hub.channels[ch[1]];
      if (!adapter) return json({ error: "not_found" }, 404);
      const parsed = await adapter.parse(req, hub.env);
      if (parsed instanceof Response) return parsed;
      for (const ev of parsed) await hub.ingest(ev);
      return json({ ok: true }); // always 200 to the chat app once verified, so it does not retry forever
    }

    // Everything below needs a key: the admin key acts as the owner, an agent key as that agent.
    // The session cookie counts only on /admin/* and only with the X-OMB-Admin header, which a cross-site form cannot set.
    const viaCookie = path.startsWith("/admin/") && adminKey && req.headers.get("x-omb-admin") === "1"
      && (await checkSession(adminKey, cookieValue(req), hub.env.now()));
    const who = viaCookie ? OWNER : await principal(hub, req, opt);
    if (!who) return json({ error: "unauthorized", message: "Authorization: Bearer <key> required" }, 401);

    if (path === "/mcp") {
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin && !opt.allowedOrigins?.includes(origin)) return json({ error: "forbidden_origin" }, 403);
      return handleMcp(hub, who, req);
    }
    const op = /^\/v1\/([a-z_]+)$/.exec(path);
    if (op) return await handleRest(hub, who, op[1], req);
    if (path.startsWith("/admin/")) {
      if (who !== OWNER) return json({ error: "forbidden", message: "admin key required" }, 403);
      return await admin(hub, req, path);
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof HubError) return json({ error: e.code, message: e.message }, e.status);
    if (e instanceof z.ZodError) return json({ error: "bad_request", message: z.prettifyError(e) }, 400);
    console.error("unhandled", e);
    return json({ error: "internal" }, 500);
  }
}

async function principal(hub: Hub, req: Request, opt: AppOptions): Promise<string | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  if (opt.adminKey && opt.adminKey.length >= 16 && safeEqual(m[1], opt.adminKey)) return OWNER;
  return hub.authAgent(m[1]);
}

async function admin(hub: Hub, req: Request, path: string): Promise<Response> {
  const s = hub.store;
  const body = async () => (req.method === "GET" ? {} : await req.json());
  const seg = path.split("/").slice(2); // ["agents", id, ...]
  const [kind, id, sub] = seg;

  if (kind === "agents" && !id && req.method === "GET") return json(await s.listAgents());
  if (kind === "overview" && req.method === "GET") return json(await overview(hub));
  if (kind === "agents" && id) {
    if (!AGENT_ID.test(id) || id === OWNER) throw new HubError(400, "bad_agent_id", "lowercase letters, digits and dashes, 2-32 chars");
    if (!sub && req.method === "PUT") {
      const prev = await s.getAgent(id);
      const a: Agent = { id, ...AgentSchema.parse(await body()), created_at: prev?.created_at ?? new Date(hub.env.now()).toISOString() };
      if (prev?.intro) a.intro = prev.intro; // the agent's own words survive config apply
      if (prev?.roster_seen) a.roster_seen = prev.roster_seen;
      if (prev?.removed) a.removed = prev.removed; // config apply does not undo a removal
      await s.putAgent(a);
      return json(a);
    }
    if (sub === "remove" && req.method === "POST") return json(await hub.remove(id));
    if (sub === "restore" && req.method === "POST") return json({ ...(await hub.restore(id)), note: "key shown once; only its SHA-256 is stored" });
    if (sub === "key" && req.method === "POST") return json({ agent: id, key: await hub.mintKey(id), note: "shown once; only its SHA-256 is stored" });
    if (sub === "watch" && req.method === "POST") {
      const token = await hub.mintWatch(id);
      return json({ agent: id, watch_url: `${new URL(req.url).origin}/watch/${token}`, note: "shown once; reveals only {unread, latest}" });
    }
    if (sub === "doorbell" && req.method === "PUT") {
      const a = await s.getAgent(id);
      if (!a) throw new HubError(404, "no_such_agent");
      a.doorbell = DoorbellSchema.parse(await body());
      await s.putAgent(a);
      await s.putRing({ ...((await s.getRing(id)) ?? emptyRing(id)), fail_count: 0, next_after: null }); // clears backoff
      return json(a.doorbell);
    }
  }
  if (kind === "rooms" && !id && req.method === "GET") return json(await s.listRooms());
  if (kind === "rooms" && id && req.method === "PUT") {
    const r = { id, ...RoomSchema.parse(await body()) };
    await s.putRoom(r);
    return json(r);
  }
  if (kind === "trust" && req.method === "GET") return json(await s.getTrust());
  if (kind === "trust" && req.method === "PUT") {
    const t = TrustSchema.parse(await body());
    await s.putTrust(t);
    return json(t);
  }
  if (kind === "rings" && req.method === "GET") return json(await s.ringLog(new URL(req.url).searchParams.get("agent"), 100));
  if (kind === "tick" && req.method === "POST") return json({ rung: await hub.ringer.tick() });
  return json({ error: "not_found" }, 404);
}

/** Everything the admin page shows, in one call. Doorbell urls and secrets stay out: a webhook url can carry a token. */
async function overview(hub: Hub) {
  const s = hub.store;
  const agents = await Promise.all((await s.listAgents()).map(async (a) => ({
    id: a.id, name: a.name, vendor: a.vendor, doorbell: a.doorbell.kind, telegram: a.handles.telegram?.username ?? null,
    own_bot: !!a.handles.telegram?.token_env, card: a.card, intro: a.intro ?? null, removed: a.removed ?? null, created_at: a.created_at,
    ring: await s.getRing(a.id), inbox: await s.unreadSummary(a.id),
  })));
  const rooms = await s.listRooms();
  const messages: Record<string, unknown[]> = {};
  for (const r of rooms) {
    const list = await s.listRoom(r.id, 40);
    messages[r.id] = await Promise.all(list.map(async (m) => ({
      id: m.id, from: m.from, to: m.to, body: m.body.slice(0, 3000), created_at: m.created_at, reply_to: m.reply_to, task_id: m.task_id,
      attachments: (m.attachments ?? []).map((x) => ({ kind: x.kind, name: x.name ?? null })),
      deliveries: (await s.deliveriesFor(m.id)).map((d) => ({ agent: d.agent, state: d.state, acked_at: d.acked_at })),
    })));
  }
  return { now: iso(hub.env.now()), agents, rooms, messages, trust: await s.getTrust(), rings: await s.ringLog(null, 60) };
}
