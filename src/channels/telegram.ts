// Telegram: one "hub" bot receives the group's updates by webhook (group privacy OFF so it sees every message) and routes
// everything. An agent with its own bot token posts under its own name and avatar; one without speaks through the hub bot,
// labelled "[Name] …". Telegram never shows a bot another bot's message in a group, so agent-to-agent traffic is routed by
// the hub, never by Telegram.
//
// Files: the hub stores Telegram file ids, never bytes. A file id belongs to the bot that saw it, so downloads use that
// bot's token, and a file re-posted by a different bot is downloaded and uploaded again.
import type { ChannelAdapter, HubEnv, InboundEvent, OutboundFile, OutboundPost, PostedFiles } from "../core/plugins";
import { HubError, type Agent, type Attachment, type AttachmentKind, type AttachmentRef } from "../core/types";
import { safeEqual } from "../core/util";

interface TgUser { id: number; is_bot?: boolean; username?: string }
interface TgFile { file_id: string; file_unique_id?: string; file_size?: number; file_name?: string; mime_type?: string;
  width?: number; height?: number; duration?: number; length?: number; is_animated?: boolean; is_video?: boolean }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  media_group_id?: string;
  reply_to_message?: { message_id: number; from?: TgUser };
  photo?: TgFile[]; video?: TgFile; animation?: TgFile; document?: TgFile; audio?: TgFile; voice?: TgFile;
  video_note?: TgFile; sticker?: TgFile;
}
export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage }

const MAX = 4000; // Telegram allows 4096 characters per message
const CAPTION_MAX = 1000; // 1024 per caption
const KINDS: Exclude<AttachmentKind, "photo">[] = ["animation", "video", "document", "audio", "voice", "video_note", "sticker"]; // animation before document: a GIF carries both

const STICKER_MIME = (f: TgFile) => (f.is_video ? "video/webm" : f.is_animated ? "application/x-tgsticker" : "image/webp");

/** The files on a Telegram message (photo: the largest size only), as attachment metadata without ids. */
export function filesOf(m: TgMessage, token_env?: string): Omit<Attachment, "id">[] {
  const out: Omit<Attachment, "id">[] = [];
  const ref = (f: TgFile): AttachmentRef => ({ channel: "telegram", file_id: f.file_id, ...(token_env ? { token_env } : {}) });
  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1];
    out.push({ kind: "photo", mime: "image/jpeg", size: p.file_size, width: p.width, height: p.height, ref: ref(p) });
  }
  for (const k of KINDS) {
    const f = m[k as Exclude<AttachmentKind, "photo">];
    if (!f || (k === "document" && m.animation)) continue;
    out.push(strip({ kind: k, name: f.file_name, mime: f.mime_type ?? (k === "sticker" ? STICKER_MIME(f) : k === "video_note" ? "video/mp4" : undefined),
      size: f.file_size, width: f.width ?? f.length, height: f.height ?? f.length, duration: f.duration, ref: ref(f) }));
  }
  return out.map(strip);
}

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Pure: a Telegram update -> normalised inbound events. Bots' own posts are skipped. */
export function parseUpdate(u: TgUpdate, hubUsername?: string): InboundEvent[] {
  const m = u.message;
  if (!m || !m.from || m.from.is_bot) return [];
  const text = m.text ?? m.caption ?? "";
  const files = filesOf(m);
  if (!text && !files.length) return [];
  const cmd = /^\/([a-z_]+)(@\w+)?(\s|$)/i.exec(text);
  const forHub = !cmd?.[2] || (hubUsername && cmd[2].slice(1).toLowerCase() === hubUsername.toLowerCase());
  const rt = m.reply_to_message;
  return [strip({
    channel: "telegram",
    external_room: String(m.chat.id),
    sender_external: String(m.from.id),
    external_id: String(m.message_id),
    text,
    reply_to_external: rt ? String(rt.message_id) : undefined,
    reply_to_username: rt?.from?.is_bot ? rt.from.username : undefined,
    command: cmd && forHub ? cmd[1].toLowerCase() : undefined,
    attachments: files.length ? files.map((f, i) => ({ id: `a${i + 1}`, ...f })) : undefined,
    media_group: m.media_group_id,
  })];
}

const base = (env: HubEnv) => env.secret("TELEGRAM_API_BASE") ?? "https://api.telegram.org"; // self-hosted Bot API, or a capture server in the smoke test

function identity(agent: Agent | null, env: HubEnv) {
  const token_env = agent?.handles.telegram?.token_env;
  const own = token_env ? env.secret(token_env) : undefined;
  const token = own ?? env.secret("TELEGRAM_HUB_TOKEN");
  if (!token) throw new Error("no Telegram bot token for this identity");
  return { token, token_env: own ? token_env : undefined, label: (text: string) => (agent && !own ? `[${agent.name}] ${text}` : text) };
}

async function call(env: HubEnv, token: string, method: string, body: Record<string, unknown> | FormData) {
  const res = await env.fetch(`${base(env)}/bot${token}/${method}`, body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: any; description?: string };
  if (!res.ok || !j.ok) throw new Error(`telegram ${method} ${res.status} ${j.description ?? ""}`.trim());
  return j.result;
}

const replyParams = (id?: string | null) => (id ? { reply_parameters: { message_id: Number(id), allow_sending_without_reply: true } } : {});

async function sendText(env: HubEnv, token: string, chat: string, text: string, reply?: string | null) {
  if (text.length > MAX) text = text.slice(0, MAX - 30) + "\n…(truncated; full text in hub)";
  // plain text: no parse_mode, so a body cannot inject markup
  const r = await call(env, token, "sendMessage", { chat_id: chat, text, ...replyParams(reply) });
  return String(r.message_id);
}

const METHOD: Record<AttachmentKind, [string, string]> = {
  photo: ["sendPhoto", "photo"], video: ["sendVideo", "video"], animation: ["sendAnimation", "animation"], document: ["sendDocument", "document"],
  audio: ["sendAudio", "audio"], voice: ["sendVoice", "voice"], video_note: ["sendVideoNote", "video_note"], sticker: ["sendSticker", "sticker"],
};

async function fetchRef(ref: Extract<AttachmentRef, { file_id: string }>, env: HubEnv): Promise<Response> {
  const token = ref.token_env ? env.secret(ref.token_env) : env.secret("TELEGRAM_HUB_TOKEN");
  if (!token) throw new HubError(503, "file_unavailable", "the bot that holds this file has no token configured");
  let file: { file_path?: string };
  try { file = await call(env, token, "getFile", { file_id: ref.file_id }); } catch (e) {
    if (/too big/i.test(String(e))) throw new HubError(413, "file_too_big", "Telegram lets bots download files up to 20 MB");
    throw new HubError(502, "file_unavailable", String(e).slice(0, 200));
  }
  if (!file.file_path) throw new HubError(502, "file_unavailable", "Telegram returned no file path");
  const res = await env.fetch(`${base(env)}/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new HubError(502, "file_unavailable", `Telegram file download ${res.status}`);
  return res;
}

async function bytesOf(f: OutboundFile, env: HubEnv): Promise<Uint8Array> {
  const s = f.source;
  if ("bytes" in s) return s.bytes;
  if ("url" in s) {
    const r = await env.fetch(s.url);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  if ("file_id" in s.ref) return new Uint8Array(await (await fetchRef(s.ref, env)).arrayBuffer());
  if ("url" in s.ref) return bytesOf({ ...f, source: { url: s.ref.url } }, env);
  throw new Error(`source missing: ${s.ref.missing}`);
}

async function sendFile(env: HubEnv, id: ReturnType<typeof identity>, chat: string, f: OutboundFile, caption: string | undefined, reply?: string | null) {
  const [method, field] = METHOD[f.kind];
  const extra = { chat_id: chat, ...(caption && f.kind !== "sticker" ? { caption } : {}), ...replyParams(reply) };
  const s = f.source;
  // A file id this bot already holds, or a public URL Telegram can fetch, goes by reference; anything else is uploaded.
  const byRef = "ref" in s && "file_id" in s.ref && s.ref.token_env === id.token_env ? s.ref.file_id
    : "url" in s ? s.url : "ref" in s && "url" in s.ref ? s.ref.url : undefined;
  if (byRef) {
    try { return await call(env, id.token, method, { ...extra, [field]: byRef }); } catch (e) {
      if (!("url" in s || ("ref" in s && "url" in s.ref))) throw e; // a URL Telegram could not take: upload it ourselves
    }
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  const bytes = await bytesOf(f, env);
  form.set(field, new Blob([bytes as BlobPart], { type: f.mime ?? "application/octet-stream" }), f.name ?? `${f.kind}${extOf(f.mime)}`);
  return call(env, id.token, method, form);
}

const extOf = (mime?: string) => ({ "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "video/mp4": ".mp4",
  "application/pdf": ".pdf", "audio/mpeg": ".mp3", "audio/ogg": ".ogg" } as Record<string, string>)[mime ?? ""] ?? "";

export const telegram: ChannelAdapter = {
  id: "telegram",
  async parse(req, env) {
    const expected = env.secret("TELEGRAM_WEBHOOK_SECRET");
    const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!expected || !safeEqual(got, expected)) return new Response("forbidden", { status: 401 });
    return parseUpdate((await req.json()) as TgUpdate, env.secret("TELEGRAM_HUB_USERNAME"));
  },
  async post({ room, agent, text, reply_to_external }: OutboundPost, env) {
    const id = identity(agent, env);
    return sendText(env, id.token, room.external_id, id.label(text), reply_to_external);
  },
  async postFiles({ room, agent, text, reply_to_external, files }, env): Promise<PostedFiles> {
    const id = identity(agent, env);
    const body = text ? id.label(text) : agent && !id.token_env ? `[${agent.name}]` : "";
    let first: string | undefined;
    let reply = reply_to_external;
    // A long text goes first as its own message and the files answer it; a short one rides as the first file's caption.
    if (body.length > CAPTION_MAX) { first = await sendText(env, id.token, room.external_id, body, reply); reply = first; }
    const refs: AttachmentRef[] = [];
    const meta: Partial<Attachment>[] = [];
    for (const [i, f] of files.entries()) {
      try {
        const r = await sendFile(env, id, room.external_id, f, i === 0 && !first ? body || undefined : undefined, reply);
        first ??= String(r.message_id);
        const got = filesOf(r, id.token_env)[0];
        refs.push(got?.ref ?? { missing: "Telegram returned no file" });
        meta.push(got ? { size: got.size, width: got.width, height: got.height, duration: got.duration, mime: got.mime } : {});
      } catch (e) {
        refs.push({ missing: String(e).slice(0, 200) });
        meta.push({});
      }
    }
    if (!first) {
      // every file failed: still say something, so the room sees the message
      first = await sendText(env, id.token, room.external_id, `${body}\n(${files.length} file(s) could not be posted)`.trim(), reply_to_external);
    }
    return { external_id: first, refs, meta };
  },
  fetchFile: fetchRef,
};
