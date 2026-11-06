// Attachments: kind inference, signed download URLs and small helpers. Platform-free (WebCrypto only).
import type { AttachmentKind, Message } from "./types";

/** What an agent may attach to send/reply. Exactly one of url, data_base64 or from. */
export interface FileInput {
  url?: string;
  data_base64?: string;
  from?: { message_id: string; attachment_id: string };
  name?: string;
  mime?: string;
  kind?: AttachmentKind;
}

export const MAX_FILES = 10;
export const MAX_UPLOAD = 20 * 1024 * 1024; // bytes per inline file (Telegram takes 50 MB uploads; Worker memory is the limit)
export const MAX_INLINE_READ = 5 * 1024 * 1024; // get_file inline=true
export const URL_TTL_S = 24 * 3600;

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeOf(name?: string, given?: string): string | undefined {
  if (given) return given;
  const ext = name?.split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  return ext ? EXT_MIME[ext] : undefined;
}

/** Photo, video, animation, audio or document, from the MIME type. Formats chat apps re-encode badly go as documents. */
export function kindOf(mime?: string): AttachmentKind {
  if (!mime) return "document";
  if (mime === "image/gif") return "animation";
  if (["image/jpeg", "image/png", "image/webp"].includes(mime)) return "photo";
  if (mime === "video/mp4") return "video";
  if (["audio/mpeg", "audio/mp4", "audio/m4a"].includes(mime)) return "audio";
  if (mime === "audio/ogg") return "voice";
  return "document";
}

export function nameFromUrl(url: string): string | undefined {
  try { const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""); return last || undefined; } catch { return undefined; }
}

export function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Appended to wake previews, so an agent knows files are waiting even where the preview shows only text. */
export function attachmentNote(m: Pick<Message, "attachments">): string {
  const a = m.attachments ?? [];
  if (!a.length) return "";
  return `\n[${a.length} attachment(s): ${a.map((x) => x.name ?? x.kind).join(", ")}]`;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const payload = (agent: string, mid: string, aid: string, exp: number) => `files|${agent}|${mid}|${aid}|${exp}`;

export async function signFile(secret: string, agent: string, mid: string, aid: string, exp: number) {
  return hmac(secret, payload(agent, mid, aid, exp));
}

export async function verifyFile(secret: string, agent: string, mid: string, aid: string, exp: number, sig: string, nowS: number) {
  if (!Number.isFinite(exp) || exp < nowS) return false;
  const want = await hmac(secret, payload(agent, mid, aid, exp));
  if (want.length !== sig.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return d === 0;
}
