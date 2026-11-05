#!/usr/bin/env node
// End-to-end smoke against a running hub (wrangler dev or deployed staging):
// a Telegram update "@muse ..." -> Muse's check_work over MCP -> ack -> reply mentioning @grok -> the reply posted as
// Muse's bot (captured) -> Grok sees it via REST -> watch URL shows counts only.
// The hub must have TELEGRAM_API_BASE=http://127.0.0.1:<capture port>, TELEGRAM_WEBHOOK_SECRET and OWNER_TELEGRAM_ID set.
//   OMB_URL=http://127.0.0.1:8787 OMB_ADMIN_KEY=... TELEGRAM_WEBHOOK_SECRET=... OWNER_TELEGRAM_ID=... node scripts/smoke.mjs
import { createServer } from "node:http";

const base = process.env.OMB_URL ?? "http://127.0.0.1:8787";
const admin = process.env.OMB_ADMIN_KEY;
const port = Number(process.env.CAPTURE_PORT ?? 8788);
const captured = [];
let nextId = 5000;
const server = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    captured.push({ path: req.url, body: JSON.parse(b || "{}") });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { message_id: ++nextId } }));
  });
}).listen(port);

let failed = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`); if (!cond) failed++; };
const call = async (method, path, key, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const mcp = async (key, method, params) => (await call("POST", "/mcp", key, { jsonrpc: "2.0", id: 1, method, params })).json;

try {
  const chat = "-100777";
  for (const [id, a] of Object.entries({
    muse: { name: "Muse", vendor: "meta-muse", doorbell: { kind: "watch" }, handles: { telegram: { username: "muse_omb_bot", token_env: "TG_TOKEN_MUSE" } } },
    grok: { name: "Grok Bot", vendor: "grok-bot", doorbell: { kind: "poll" }, handles: { telegram: { username: "grok_omb_bot" } } },
  })) await call("PUT", `/admin/agents/${id}`, admin, a);
  await call("PUT", "/admin/rooms/main", admin, { name: "Main", channel: "telegram", external_id: chat, members: ["muse", "grok"] });
  const kMuse = (await call("POST", "/admin/agents/muse/key", admin)).json.key;
  const kGrok = (await call("POST", "/admin/agents/grok/key", admin)).json.key;
  const watch = new URL((await call("POST", "/admin/agents/muse/watch", admin)).json.watch_url).pathname;
  check("admin set-up", !!kMuse && !!kGrok);
  check("401 without key", (await call("GET", "/v1/me")).status === 401);

  const upd = { update_id: Date.now(), message: { message_id: 42, from: { id: Number(process.env.OWNER_TELEGRAM_ID), username: "owner" },
    chat: { id: Number(chat), type: "supergroup" }, text: "@muse_omb_bot summarise today's AI news" } };
  const hook = await call("POST", "/channels/telegram/webhook", null, upd, { "x-telegram-bot-api-secret-token": process.env.TELEGRAM_WEBHOOK_SECRET });
  check("telegram webhook accepted", hook.status === 200, JSON.stringify(hook.json));
  const w0 = (await call("GET", watch)).json;
  check("watch URL shows only counts", w0.unread >= 1 && Object.keys(w0).sort().join() === "latest,unread", JSON.stringify(w0));

  const init = await mcp(kMuse, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  check("MCP initialize", init.result?.serverInfo?.name === "oh-my-bot");
  const tools = (await mcp(kMuse, "tools/list", {})).result.tools.map((t) => t.name);
  check("MCP tools/list", tools.includes("check_work") && tools.includes("ack"), tools.join(","));
  const work = (await mcp(kMuse, "tools/call", { name: "check_work", arguments: {} })).result.structuredContent;
  const item = work.items.find((i) => i.body.includes("summarise today's AI news"));
  check("Muse check_work over MCP sees the owner's mention", item?.trust === "owner", item?.body.split("\n")[0]);
  const ack = (await mcp(kMuse, "tools/call", { name: "ack", arguments: { snapshot_id: work.snapshot_id } })).result.structuredContent;
  check("ack by snapshot", ack.acked.length === work.items.length && ack.unread === 0, JSON.stringify(ack));
  const reply = (await mcp(kMuse, "tools/call", { name: "reply", arguments: { message_id: item.id, body: "Top story: ... @grok anything on X?", rid: `smoke-${Date.now()}` } })).result.structuredContent;
  check("reply posted to the group", reply.outbound === "posted", reply.outbound);
  const post = captured.find((c) => c.path === "/botMUSE-SMOKE-TOKEN/sendMessage");
  check("outbound sent as Muse's own bot", post?.body.chat_id === chat && post?.body.reply_parameters?.message_id === 42, JSON.stringify(post?.body));
  const g = (await call("POST", "/v1/check_work", kGrok, {})).json;
  check("Grok receives Muse's @mention via the hub (REST)", g.items.length === 1 && g.items[0].from === "muse" && g.items[0].trust === "peer");
  const w1 = (await call("GET", watch)).json;
  check("watch URL back to zero after ack", w1.unread === 0, JSON.stringify(w1));
} catch (e) {
  console.error(e);
  failed++;
} finally {
  server.close();
  console.log(failed ? `${failed} check(s) failed` : "smoke: all checks passed");
  process.exit(failed ? 1 : 0);
}
