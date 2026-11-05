#!/usr/bin/env node
// oh-my-bot admin CLI. Talks to the hub's /admin API with the admin key; never writes secrets to disk.
//   OMB_URL=https://oh-my-bot.<you>.workers.dev OMB_ADMIN_KEY=... node scripts/omb.mjs <command>
import { readFileSync } from "node:fs";

const HELP = `usage: omb.mjs <command>
  apply <config.json>                      upsert agents, rooms and trust rules from a config file
  add <id> --name N [--vendor V] [--doorbell K] [--url U] [--secret-env S] [--topic T] [--tg-username U] [--tg-token-env E]
                                           create/update an agent and print its key (once)
  key <id>                                 mint a new key (the old one stops working); printed once
  watch <id>                               mint a keyless watch URL (reveals only {unread, latest}); printed once
  doorbell <id> <kind> [--url U] [--secret-env S] [--topic T] [--server URL]
                                           set how an agent is woken (http|webhook|watch|poll|ntfy); clears backoff
  room <id> --chat <external id> --members a,b [--channel telegram] [--name N]
  trust <recipient> <sender,sender|none>   who besides the owner may give <recipient> work
  list                                     agents (no secrets), rooms, trust rules
  rings [agent]                            recent doorbell log
  tick                                     run the ring/recovery pass now (the cron does this every minute)
  telegram-webhook                         point the hub bot's webhook at $OMB_URL (needs TELEGRAM_HUB_TOKEN, TELEGRAM_WEBHOOK_SECRET)
env: OMB_URL, OMB_ADMIN_KEY`;

const [cmd, ...rest] = process.argv.slice(2);
const pos = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const base = (process.env.OMB_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const die = (m) => { console.error(m); process.exit(1); };

async function api(method, path, body) {
  const key = process.env.OMB_ADMIN_KEY ?? die("set OMB_ADMIN_KEY");
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) die(`${method} ${path} -> ${res.status} ${JSON.stringify(j)}`);
  return j;
}
const doorbellFrom = (kind) => Object.fromEntries(Object.entries({ kind, url: flag("url"), secret_env: flag("secret-env"), topic: flag("topic"), server: flag("server") }).filter(([, v]) => v));

switch (cmd) {
  case "apply": {
    const cfg = JSON.parse(readFileSync(pos[0] ?? die("apply <config.json>"), "utf8"));
    for (const [id, a] of Object.entries(cfg.agents ?? {})) { await api("PUT", `/admin/agents/${id}`, a); console.error(`agent ${id}`); }
    for (const [id, r] of Object.entries(cfg.rooms ?? {})) { await api("PUT", `/admin/rooms/${id}`, r); console.error(`room ${id}`); }
    if (cfg.trust) { await api("PUT", "/admin/trust", cfg.trust); console.error("trust rules"); }
    console.error("done. Mint keys with: omb.mjs key <id>");
    break;
  }
  case "add": {
    const id = pos[0] ?? die("add <id> --name N");
    const prev = (await api("GET", "/admin/agents")).find((a) => a.id === id);
    const handles = { ...(prev?.handles ?? {}) };
    if (flag("tg-username")) handles.telegram = { username: flag("tg-username"), ...(flag("tg-token-env") ? { token_env: flag("tg-token-env") } : {}) };
    await api("PUT", `/admin/agents/${id}`, { ...prev, name: flag("name") ?? prev?.name ?? id, vendor: flag("vendor") ?? prev?.vendor ?? "custom",
      doorbell: flag("doorbell") ? doorbellFrom(flag("doorbell")) : prev?.doorbell ?? { kind: "poll" }, handles, id: undefined, created_at: undefined });
    console.log((await api("POST", `/admin/agents/${id}/key`)).key);
    break;
  }
  case "key": console.log((await api("POST", `/admin/agents/${pos[0] ?? die("key <id>")}/key`)).key); break;
  case "watch": console.log((await api("POST", `/admin/agents/${pos[0] ?? die("watch <id>")}/watch`)).watch_url); break;
  case "doorbell": console.log(JSON.stringify(await api("PUT", `/admin/agents/${pos[0]}/doorbell`, doorbellFrom(pos[1] ?? die("doorbell <id> <kind>"))))); break;
  case "room": {
    const r = { name: flag("name") ?? pos[0], channel: flag("channel") ?? "telegram", external_id: flag("chat") ?? die("--chat required"),
      members: (flag("members") ?? "").split(",").filter(Boolean) };
    console.log(JSON.stringify(await api("PUT", `/admin/rooms/${pos[0] ?? die("room <id>")}`, r)));
    break;
  }
  case "trust": {
    const t = await api("GET", "/admin/trust");
    const [who, senders] = pos;
    if (!who || !senders) die("trust <recipient> <a,b|none>");
    if (senders === "none") delete t[who]; else t[who] = senders.split(",");
    console.log(JSON.stringify(await api("PUT", "/admin/trust", t)));
    break;
  }
  case "list": {
    for (const a of await api("GET", "/admin/agents")) console.log(`${a.id.padEnd(12)} ${a.vendor.padEnd(15)} doorbell=${a.doorbell.kind} ${a.name}`);
    for (const r of await api("GET", "/admin/rooms")) console.log(`room ${r.id}: ${r.channel} ${r.external_id} [${r.members.join(", ")}]`);
    console.log("trust", JSON.stringify(await api("GET", "/admin/trust")));
    break;
  }
  case "rings": for (const e of await api("GET", `/admin/rings${pos[0] ? `?agent=${pos[0]}` : ""}`)) console.log(`${e.at} ${e.agent} ${e.kind} ${e.status} ${e.detail ?? ""}`); break;
  case "tick": console.log(JSON.stringify(await api("POST", "/admin/tick"))); break;
  case "telegram-webhook": {
    const token = process.env.TELEGRAM_HUB_TOKEN ?? die("set TELEGRAM_HUB_TOKEN");
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? die("set TELEGRAM_WEBHOOK_SECRET");
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/channels/telegram/webhook`, secret_token: secret, allowed_updates: ["message"] }) });
    console.log(JSON.stringify(await res.json()));
    break;
  }
  default: console.log(HELP);
}
