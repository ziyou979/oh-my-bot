// Persistence boundary. Two implementations: MemoryStore (tests, Node server) and D1Store (Workers).
// Methods that must be atomic say so; every implementation has to honour that.
import type { Agent, Attachment, Delivery, Message, RingLogEntry, RingState, Room, Snapshot, Task, Trust, TrustRules } from "./types";

export interface PendingItem { delivery: Delivery; message: Message }

export interface Store {
  // agents and credentials (only SHA-256 hashes are ever stored)
  getAgent(id: string): Promise<Agent | null>;
  listAgents(): Promise<Agent[]>;
  putAgent(a: Agent): Promise<void>;
  setKeyHash(agent: string, hash: string): Promise<void>;
  agentByKeyHash(hash: string): Promise<string | null>;
  setWatchHash(agent: string, hash: string): Promise<void>;
  agentByWatchHash(hash: string): Promise<string | null>;

  // rooms and trust rules
  getRoom(id: string): Promise<Room | null>;
  roomByExternal(channel: string, externalId: string): Promise<Room | null>;
  listRooms(): Promise<Room[]>;
  putRoom(r: Room): Promise<void>;
  getTrust(): Promise<TrustRules>;
  putTrust(t: TrustRules): Promise<void>;

  /** Atomic: insert the message and one unread delivery per recipient, unless (from, rid) exists.
   *  Returns the stored message (the original one on a duplicate rid). */
  insertMessage(m: Message, deliveries: { agent: string; trust: Trust }[]): Promise<{ message: Message; inserted: boolean }>;
  getMessage(id: string): Promise<Message | null>;
  messageByExternal(room: string, externalId: string): Promise<Message | null>;
  setExternalId(id: string, externalId: string): Promise<void>;
  setAttachments(id: string, attachments: Attachment[]): Promise<void>;
  /** Messages of one chat-app album in a room, oldest first. */
  listGroup(roomId: string, group: string): Promise<Message[]>;
  listThread(threadId: string, limit: number): Promise<Message[]>;
  listRoom(roomId: string, limit: number): Promise<Message[]>;
  /** Messages sent by `from` since `since` (ISO), newest first; for rate limits and duplicate suppression. */
  recentFrom(from: string, since: string): Promise<Message[]>;
  deliveriesFor(messageId: string): Promise<Delivery[]>;

  // two-phase delivery
  /** Unread or shown-but-unacked deliveries for an agent, oldest first. */
  pending(agent: string, limit: number): Promise<PendingItem[]>;
  /** Mark those deliveries shown under the snapshot and record it (atomic). */
  saveSnapshot(s: Snapshot): Promise<void>;
  getSnapshot(id: string): Promise<Snapshot | null>;
  latestSnapshot(agent: string): Promise<Snapshot | null>;
  /** Ack shown deliveries of `agent` among messageIds. Returns ids actually acked now. */
  ack(agent: string, messageIds: string[], now: string): Promise<string[]>;
  unreadSummary(agent: string): Promise<{ unread: number; latest: string | null; oldest_at: string | null }>;

  // tasks
  /** Returns the existing task when (created_by, rid) already exists. */
  insertTask(t: Task): Promise<{ task: Task; inserted: boolean }>;
  getTask(id: string): Promise<Task | null>;
  /** Atomic: claim if submitted, or working with an expired lease, or already claimed by this agent. */
  claimTask(id: string, agent: string, now: string, leaseUntil: string): Promise<Task | null>;
  /** Atomic compare-and-set on `expectState`; null when the task moved on. */
  updateTask(id: string, expectState: Task["state"], patch: Partial<Task>): Promise<Task | null>;
  /** Open (not terminal) tasks assigned to the agent, or unassigned in one of `rooms`. */
  openTasksFor(agent: string, rooms: string[]): Promise<Task[]>;

  // doorbells
  getRing(agent: string): Promise<RingState | null>;
  putRing(s: RingState): Promise<void>;
  logRing(e: RingLogEntry): Promise<void>;
  ringLog(agent: string | null, limit: number): Promise<RingLogEntry[]>;
}

export const emptyRing = (agent: string): RingState => ({
  agent, pending: false, next_after: null, fail_count: 0, last_ring_at: null, last_ok_at: null, last_check_at: null, recover_count: 0,
});
