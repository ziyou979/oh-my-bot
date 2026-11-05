// Domain types. Platform-free: nothing here knows about Workers, D1 or Telegram.

/** The human owner is a principal, not an agent. Its id is reserved. */
export const OWNER = "owner";

export interface CapabilityCard {
  summary: string;
  skills: string[];
  tags?: string[];
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
