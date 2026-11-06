// Domain types. Platform-free: nothing here knows about Workers, D1 or Telegram.

/** The human owner is a principal, not an agent. Its id is reserved. */
export const OWNER = "owner";

export interface CapabilityCard {
  summary: string;
  skills: string[];
  tags?: string[];
}

/** What an agent says about itself (`introduce`). Self-reported: shown to others as data, never as instructions. */
export interface AgentIntro {
  summary: string;
  can: string[]; // what to hand it
  cannot?: string[]; // what it won't or can't do
  needs_owner_ok?: string[]; // what it only does after the owner confirms
  response_time?: string; // its own estimate, e.g. "2-5 min"
  examples?: string[]; // requests that work well
  updated_at: string;
}

/** How the hub wakes an agent. `kind` picks a Doorbell from the registry; the rest is that doorbell's config. */
export interface DoorbellConfig {
  kind: string; // http | webhook | watch | poll | ntfy | <yours>
  url?: string;
  /** Name of an env secret (never the secret itself) sent as the bearer token / auth. */
  secret_env?: string;
  topic?: string; // ntfy
  server?: string; // ntfy server, default https://ntfy.sh
}

/** Per-channel identity of an agent, e.g. telegram: { username: "muse_omb_bot", token_env: "TG_TOKEN_MUSE" }. */
export interface ChannelHandle {
  username: string;
  token_env?: string;
}

export interface Agent {
  id: string;
  name: string;
  vendor: string; // meta-muse | wabi | today | hark | claude-routine | grok-bot | custom
  card: CapabilityCard;
  doorbell: DoorbellConfig;
  handles: Record<string, ChannelHandle>;
  /** Extra @names that address this agent in chat, besides its id and channel usernames. */
  aliases?: string[];
  /** Written by the agent itself; config apply never overwrites it. */
  intro?: AgentIntro;
  /** Hash of the teammate list this agent last received, so check_work sends it again only when it changes. */
  roster_seen?: string;
  /** Set when the owner removed the agent: its key and watch link are revoked and it left these rooms. */
  removed?: { at: string; rooms: string[] };
  created_at: string;
}

export interface Room {
  id: string;
  name: string;
  channel: string; // telegram | ...
  external_id: string; // e.g. Telegram chat id
  members: string[]; // agent ids
}

/** recipient -> senders that may give it work. The owner may always give work. */
export type TrustRules = Record<string, string[]>;
export type Trust = "owner" | "delegated" | "peer";

export type AttachmentKind = "photo" | "video" | "animation" | "document" | "audio" | "voice" | "video_note" | "sticker";

/** Where an attachment's bytes live. Never shown to agents: a chat app's file id is useless without that bot's token. */
export type AttachmentRef =
  | { channel: string; file_id: string; token_env?: string } // token_env: the bot that holds the file id (unset = hub bot)
  | { url: string }
  | { missing: string }; // the upload failed; the reason

/** A file on a message: a photo, video, PDF, voice note... The hub stores references, never the bytes. */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  name?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  ref: AttachmentRef;
}

export interface Message {
  id: string;
  from: string; // agent id or OWNER
  room: string | null;
  to: string[]; // recipients that get a delivery (mentions / direct)
  body: string;
  reply_to: string | null;
  thread_id: string;
  rid: string;
  hop: number;
  task_id: string | null;
  body_hash: string;
  external_id: string | null; // id of the mirrored post on the room's channel
  attachments: Attachment[];
  media_group: string | null; // chat-app album id: photos sent together arrive as separate messages
  created_at: string;
}

export type DeliveryState = "unread" | "shown" | "acked";

export interface Delivery {
  message_id: string;
  agent: string;
  state: DeliveryState;
  trust: Trust;
  snapshot_id: string | null;
  created_at: string;
  acked_at: string | null;
}

export interface Snapshot {
  id: string;
  agent: string;
  message_ids: string[];
  max_hop: number;
  created_at: string;
}

/** A2A-style task states. */
export type TaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";
export const TERMINAL: TaskState[] = ["completed", "failed", "canceled"];

export interface Task {
  id: string;
  title: string;
  body: string;
  created_by: string;
  assignee: string | null; // null = open to eligible members of `room`
  room: string | null;
  state: TaskState;
  claimed_by: string | null;
  lease_until: string | null;
  result: string | null;
  rid: string;
  message_id: string;
  created_at: string;
  updated_at: string;
}

export interface RingState {
  agent: string;
  pending: boolean;
  next_after: string | null; // coalesce window or backoff end
  fail_count: number;
  last_ring_at: string | null;
  last_ok_at: string | null;
  last_check_at: string | null; // last check_work by the agent
  recover_count: number;
}

export interface RingLogEntry {
  agent: string;
  kind: string;
  status: "ok" | "failed" | "coalesced" | "passive" | "backoff" | "recovered";
  detail: string | null;
  at: string;
}

export class HubError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}
