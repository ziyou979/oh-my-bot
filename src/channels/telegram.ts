// Telegram: one "hub" bot receives the group's updates by webhook (group privacy OFF so it sees every message);
// each agent posts as its own bot (one token per agent identity). Telegram never shows a bot another bot's message in a
// group, so agent-to-agent traffic is routed by the hub, never by Telegram.
import type { ChannelAdapter, InboundEvent } from "../core/plugins";
import { safeEqual } from "../core/util";

interface TgUser { id: number; is_bot?: boolean; username?: string }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number; from?: TgUser };
}
export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage }

const MAX = 4000; // Telegram allows 4096 characters per message

/** Pure: a Telegram update -> normalised inbound events. Bots' own posts are skipped. */
export function parseUpdate(u: TgUpdate, hubUsername?: string): InboundEvent[] {
  const m = u.message;
  const text = m?.text ?? m?.caption;
  if (!m || !text || !m.from || m.from.is_bot) return [];
  const cmd = /^\/([a-z_]+)(@\w+)?(\s|$)/i.exec(text);
  const forHub = !cmd?.[2] || (hubUsername && cmd[2].slice(1).toLowerCase() === hubUsername.toLowerCase());
  const rt = m.reply_to_message;
  return [{
    channel: "telegram",
    external_room: String(m.chat.id),
    sender_external: String(m.from.id),
    external_id: String(m.message_id),
    text,
    reply_to_external: rt ? String(rt.message_id) : undefined,
    reply_to_username: rt?.from?.is_bot ? rt.from.username : undefined,
    command: cmd && forHub ? cmd[1].toLowerCase() : undefined,
  }];
}

export const telegram: ChannelAdapter = {
  id: "telegram",
  async parse(req, env) {
    const expected = env.secret("TELEGRAM_WEBHOOK_SECRET");
    const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!expected || !safeEqual(got, expected)) return new Response("forbidden", { status: 401 });
    return parseUpdate((await req.json()) as TgUpdate, env.secret("TELEGRAM_HUB_USERNAME"));
  },
  async post({ room, agent, text, reply_to_external }, env) {
    const own = agent?.handles.telegram?.token_env ? env.secret(agent.handles.telegram.token_env) : undefined;
    const token = own ?? env.secret("TELEGRAM_HUB_TOKEN");
    if (!token) throw new Error("no Telegram bot token for this identity");
    // Without its own bot the agent speaks through the hub bot, labelled with its name.
    let body = agent && !own ? `[${agent.name}] ${text}` : text;
    if (body.length > MAX) body = body.slice(0, MAX - 30) + "\n…(truncated; full text in hub)";
    // TELEGRAM_API_BASE: a self-hosted Bot API server, or a local capture server in the smoke test.
    const base = env.secret("TELEGRAM_API_BASE") ?? "https://api.telegram.org";
    const res = await env.fetch(`${base}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: room.external_id, text: body, // plain text: no parse_mode, so a body cannot inject markup
        ...(reply_to_external ? { reply_parameters: { message_id: Number(reply_to_external), allow_sending_without_reply: true } } : {}),
      }),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id: number }; description?: string };
    if (!res.ok || !j.ok) throw new Error(`telegram ${res.status} ${j.description ?? ""}`.trim());
    return String(j.result!.message_id);
  },
};
