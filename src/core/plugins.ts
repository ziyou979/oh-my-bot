// Plugin contracts. A doorbell wakes an agent; a channel adapter connects a chat app. Both are small on purpose:
// add one by implementing the interface and registering it (see docs/architecture.md).
import type { Agent, Attachment, AttachmentKind, AttachmentRef, DoorbellConfig, Room } from "./types";

/** What the hub hands to plugins: secrets by name, an injectable fetch and clock. */
export interface HubEnv {
  secret(name: string): string | undefined;
  fetch: typeof fetch;
  now(): number;
}

export interface RingItem { id: string; from: string; trust: string; room: string | null; body: string }

export interface RingPayload {
  agent: Agent;
  unread: number;
  latest: string | null;
  /** The newest items with their full bodies, already wrapped as data. */
  items: RingItem[];
  /** Fixed text: what the woken agent should do. Never derived from message content. */
  instruction: string;
}

export interface RingResult { ok: boolean; status?: number; detail?: string; busy?: boolean }

export interface Doorbell {
  kind: string;
  /** Passive doorbells never call out (watch, poll): the agent pulls. */
  passive?: boolean;
  ring(cfg: DoorbellConfig, p: RingPayload, env: HubEnv): Promise<RingResult>;
}

/** A message that arrived from a chat app, normalised. */
export interface InboundEvent {
  channel: string;
  external_room: string;
  sender_external: string; // the human's user id on that app
  external_id: string; // the message id on that app
  text: string;
  reply_to_external?: string;
  reply_to_username?: string; // when replying to a bot's post: which bot
  command?: string; // e.g. "omb" for "/omb"
  /** Files on the message, already referenced on this channel (ref.channel = channel). */
  attachments?: Attachment[];
  media_group?: string;
}

export interface OutboundPost {
  room: Room;
  agent: Agent | null; // null = the hub's own identity
  text: string;
  reply_to_external?: string | null;
}

/** A file to post. `bytes` are held only for the length of the request; the hub keeps the channel's reference afterwards. */
export interface OutboundFile {
  kind: AttachmentKind;
  name?: string;
  mime?: string;
  source: { ref: AttachmentRef } | { url: string } | { bytes: Uint8Array };
}

export interface PostedFiles {
  external_id: string;
  /** One per file, in order: where the posted file now lives on the channel (or why it is missing). */
  refs: AttachmentRef[];
  /** Metadata the channel reported back (size, dimensions), in order. */
  meta?: Partial<Attachment>[];
}

export interface ChannelAdapter {
  id: string;
  /** Verify and parse a webhook request. Return a Response to reject it. */
  parse(req: Request, env: HubEnv): Promise<InboundEvent[] | Response>;
  /** Post as the agent's own identity on this app; returns the external message id. */
  post(p: OutboundPost, env: HubEnv): Promise<string | null>;
  /** Post text with files. Optional: a channel without it gets the text plus a list of the file names. */
  postFiles?(p: OutboundPost & { files: OutboundFile[] }, env: HubEnv): Promise<PostedFiles>;
  /** Fetch a file this channel holds. Optional: refs of a channel without it cannot be downloaded. */
  fetchFile?(ref: Extract<AttachmentRef, { file_id: string }>, env: HubEnv): Promise<Response>;
}
