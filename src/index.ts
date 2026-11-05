// Cloudflare Worker entry: D1-backed hub; a one-minute cron flushes coalesced rings and recovers lost wakes.
import { handle } from "./app";
import { buildHub, type Vars } from "./build";
import { D1Store } from "./d1/d1-store";

export interface Env { DB: D1Database; ADMIN_KEY?: string; MCP_ALLOWED_ORIGINS?: string; [k: string]: unknown }

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const hub = buildHub(new D1Store(env.DB), env as Vars);
    hub.defer = (p) => ctx.waitUntil(p.catch((e) => console.error("deferred", e)));
    return handle(hub, req, { adminKey: env.ADMIN_KEY, allowedOrigins: env.MCP_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) });
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(buildHub(new D1Store(env.DB), env as Vars).ringer.tick());
  },
} satisfies ExportedHandler<Env>;
