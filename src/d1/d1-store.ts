// D1 Store. Atomic methods use a single conditional statement or a D1 batch (one transaction).
import type { PendingItem, Store } from "../core/store";
import type { Agent, Delivery, Message, RingLogEntry, RingState, Room, Snapshot, Task, Trust, TrustRules } from "../core/types";

type Row = Record<string, unknown>;

const toMessage = (r: Row): Message => ({
  id: r.id as string, from: r.from_id as string, room: (r.room as string) ?? null, to: JSON.parse(r.to_ids as string),
  body: r.body as string, reply_to: (r.reply_to as string) ?? null, thread_id: r.thread_id as string, rid: r.rid as string,
  hop: Number(r.hop), task_id: (r.task_id as string) ?? null, body_hash: r.body_hash as string,
  external_id: (r.external_id as string) ?? null, created_at: r.created_at as string,
});
const toDelivery = (r: Row): Delivery => ({
  message_id: r.message_id as string, agent: r.agent as string, state: r.state as Delivery["state"], trust: r.trust as Trust,
  snapshot_id: (r.snapshot_id as string) ?? null, created_at: r.d_created_at as string ?? r.created_at as string, acked_at: (r.acked_at as string) ?? null,
});
const toRoom = (r: Row): Room => ({ id: r.id as string, channel: r.channel as string, external_id: r.external_id as string, ...JSON.parse(r.data as string) });
const toAgent = (r: Row): Agent => ({ id: r.id as string, ...JSON.parse(r.profile as string) });
const toSnap = (r: Row): Snapshot => ({ id: r.id as string, agent: r.agent as string, message_ids: JSON.parse(r.message_ids as string), max_hop: Number(r.max_hop), created_at: r.created_at as string });
const TASK_COLS = ["id", "title", "body", "created_by", "assignee", "room", "state", "claimed_by", "lease_until", "result", "rid", "message_id", "created_at", "updated_at"] as const;
const toTask = (r: Row) => Object.fromEntries(TASK_COLS.map((c) => [c, r[c] ?? null])) as unknown as Task;

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  private q(sql: string, ...args: unknown[]) { return this.db.prepare(sql).bind(...args); }
  private async one(sql: string, ...args: unknown[]) { return (await this.q(sql, ...args).first<Row>()) ?? null; }
  private async all(sql: string, ...args: unknown[]) { return (await this.q(sql, ...args).all<Row>()).results; }

  async getAgent(id: string) { const r = await this.one("SELECT * FROM agents WHERE id = ?", id); return r ? toAgent(r) : null; }
  async listAgents() { return (await this.all("SELECT * FROM agents ORDER BY id")).map(toAgent); }
  async putAgent(a: Agent) {
    const { id, ...profile } = a;
    await this.q("INSERT INTO agents (id, profile) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET profile = excluded.profile", id, JSON.stringify(profile)).run();
  }
  async setKeyHash(agent: string, hash: string) { await this.q("UPDATE agents SET key_hash = ? WHERE id = ?", hash, agent).run(); }
  async agentByKeyHash(hash: string) { return ((await this.one("SELECT id FROM agents WHERE key_hash = ?", hash))?.id as string) ?? null; }
  async setWatchHash(agent: string, hash: string) { await this.q("UPDATE agents SET watch_hash = ? WHERE id = ?", hash, agent).run(); }
  async agentByWatchHash(hash: string) { return ((await this.one("SELECT id FROM agents WHERE watch_hash = ?", hash))?.id as string) ?? null; }

  async getRoom(id: string) { const r = await this.one("SELECT * FROM rooms WHERE id = ?", id); return r ? toRoom(r) : null; }
  async roomByExternal(channel: string, ext: string) {
    const r = await this.one("SELECT * FROM rooms WHERE channel = ? AND external_id = ?", channel, ext);
    return r ? toRoom(r) : null;
  }
  async listRooms() { return (await this.all("SELECT * FROM rooms ORDER BY id")).map(toRoom); }
  async putRoom(r: Room) {
    await this.q("INSERT INTO rooms (id, channel, external_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, external_id = excluded.external_id, data = excluded.data",
      r.id, r.channel, r.external_id, JSON.stringify({ name: r.name, members: r.members })).run();
  }
  async getTrust() { const r = await this.one("SELECT v FROM settings WHERE k = 'trust'"); return r ? (JSON.parse(r.v as string) as TrustRules) : {}; }
  async putTrust(t: TrustRules) {
    await this.q("INSERT INTO settings (k, v) VALUES ('trust', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(t)).run();
  }

  async insertMessage(m: Message, ds: { agent: string; trust: Trust }[]) {
    // One transaction: the message row is ignored on a duplicate (from_id, rid); deliveries are inserted only if our row exists.
    await this.db.batch([
      this.q(`INSERT OR IGNORE INTO messages (id, from_id, room, to_ids, body, reply_to, thread_id, rid, hop, task_id, body_hash, external_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.id, m.from, m.room, JSON.stringify(m.to), m.body, m.reply_to, m.thread_id, m.rid, m.hop, m.task_id, m.body_hash, m.external_id, m.created_at),
      ...ds.map((d) => this.q(`INSERT INTO deliveries (message_id, agent, state, trust, created_at)
              SELECT ?, ?, 'unread', ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)`, m.id, d.agent, d.trust, m.created_at, m.id)),
    ]);
    const r = await this.one("SELECT * FROM messages WHERE from_id = ? AND rid = ?", m.from, m.rid);
    const message = toMessage(r!);
    return { message, inserted: message.id === m.id };
  }
  async getMessage(id: string) { const r = await this.one("SELECT * FROM messages WHERE id = ?", id); return r ? toMessage(r) : null; }
  async messageByExternal(room: string, ext: string) {
    const r = await this.one("SELECT * FROM messages WHERE room = ? AND external_id = ?", room, ext);
    return r ? toMessage(r) : null;
  }
  async setExternalId(id: string, ext: string) { await this.q("UPDATE messages SET external_id = ? WHERE id = ?", ext, id).run(); }
  async listThread(threadId: string, limit: number) {
    return (await this.all("SELECT * FROM (SELECT *, rowid AS rowid FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, rowid", threadId, limit)).map(toMessage);
  }
  async listRoom(roomId: string, limit: number) {
    return (await this.all("SELECT * FROM (SELECT *, rowid AS rowid FROM messages WHERE room = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, rowid", roomId, limit)).map(toMessage);
  }
  async recentFrom(from: string, since: string) {
    return (await this.all("SELECT * FROM messages WHERE from_id = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1000", from, since)).map(toMessage);
  }
  async deliveriesFor(messageId: string) {
    return (await this.all("SELECT * FROM deliveries WHERE message_id = ?", messageId)).map(toDelivery);
  }

  async pending(agent: string, limit: number): Promise<PendingItem[]> {
    const rows = await this.all(`SELECT m.*, d.message_id, d.agent, d.state, d.trust, d.snapshot_id, d.acked_at, d.created_at AS d_created_at
      FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE d.agent = ? AND d.state <> 'acked' ORDER BY d.created_at, d.rowid LIMIT ?`, agent, limit);
    return rows.map((r) => ({ delivery: toDelivery(r), message: toMessage(r) }));
  }
  async saveSnapshot(s: Snapshot) {
    await this.db.batch([
      this.q("INSERT INTO snapshots (id, agent, message_ids, max_hop, created_at) VALUES (?, ?, ?, ?, ?)", s.id, s.agent, JSON.stringify(s.message_ids), s.max_hop, s.created_at),
      this.q(`UPDATE deliveries SET state = 'shown', snapshot_id = ? WHERE agent = ? AND state <> 'acked'
              AND message_id IN (SELECT value FROM json_each(?))`, s.id, s.agent, JSON.stringify(s.message_ids)),
    ]);
  }
  async getSnapshot(id: string) { const r = await this.one("SELECT * FROM snapshots WHERE id = ?", id); return r ? toSnap(r) : null; }
  async latestSnapshot(agent: string) {
    const r = await this.one("SELECT * FROM snapshots WHERE agent = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", agent);
    return r ? toSnap(r) : null;
  }
  async ack(agent: string, ids: string[], now: string) {
    const rows = await this.all(`UPDATE deliveries SET state = 'acked', acked_at = ? WHERE agent = ? AND state = 'shown'
      AND message_id IN (SELECT value FROM json_each(?)) RETURNING message_id`, now, agent, JSON.stringify(ids));
    return rows.map((r) => r.message_id as string);
  }
  async unreadSummary(agent: string) {
    const r = await this.one(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest,
      (SELECT message_id FROM deliveries WHERE agent = ?1 AND state <> 'acked' ORDER BY created_at DESC, rowid DESC LIMIT 1) AS latest
      FROM deliveries WHERE agent = ?1 AND state <> 'acked'`, agent);
    return { unread: Number(r?.n ?? 0), latest: (r?.latest as string) ?? null, oldest_at: (r?.oldest as string) ?? null };
  }

  async insertTask(t: Task) {
    await this.q(`INSERT OR IGNORE INTO tasks (${TASK_COLS.join(", ")}) VALUES (${TASK_COLS.map(() => "?").join(", ")})`, ...TASK_COLS.map((c) => t[c])).run();
    const task = toTask((await this.one("SELECT * FROM tasks WHERE created_by = ? AND rid = ?", t.created_by, t.rid))!);
    return { task, inserted: task.id === t.id };
  }
  async getTask(id: string) { const r = await this.one("SELECT * FROM tasks WHERE id = ?", id); return r ? toTask(r) : null; }
  async claimTask(id: string, agent: string, now: string, leaseUntil: string) {
    const r = await this.one(`UPDATE tasks SET state = 'working', claimed_by = ?2, lease_until = ?4, updated_at = ?3
      WHERE id = ?1 AND (state = 'submitted' OR (state = 'working' AND (claimed_by = ?2 OR lease_until < ?3))) RETURNING *`, id, agent, now, leaseUntil);
    return r ? toTask(r) : null;
  }
  async updateTask(id: string, expect: Task["state"], patch: Partial<Task>) {
    const keys = Object.keys(patch).filter((k) => (TASK_COLS as readonly string[]).includes(k) && k !== "id");
    const r = await this.one(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND state = ? RETURNING *`,
      ...keys.map((k) => (patch as Row)[k]), id, expect);
    return r ? toTask(r) : null;
  }
  async openTasksFor(agent: string, rooms: string[]) {
    return (await this.all(`SELECT * FROM tasks WHERE state NOT IN ('completed', 'failed', 'canceled')
      AND (assignee = ? OR (assignee IS NULL AND room IN (SELECT value FROM json_each(?)))) ORDER BY created_at, rowid`, agent, JSON.stringify(rooms))).map(toTask);
  }

  async getRing(agent: string) { const r = await this.one("SELECT data FROM rings WHERE agent = ?", agent); return r ? (JSON.parse(r.data as string) as RingState) : null; }
  async putRing(s: RingState) {
    await this.q("INSERT INTO rings (agent, data) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET data = excluded.data", s.agent, JSON.stringify(s)).run();
  }
  async logRing(e: RingLogEntry) {
    await this.q("INSERT INTO ring_log (agent, kind, status, detail, at) VALUES (?, ?, ?, ?, ?)", e.agent, e.kind, e.status, e.detail, e.at).run();
  }
  async ringLog(agent: string | null, limit: number) {
    const rows = agent
      ? await this.all("SELECT * FROM ring_log WHERE agent = ? ORDER BY seq DESC LIMIT ?", agent, limit)
      : await this.all("SELECT * FROM ring_log ORDER BY seq DESC LIMIT ?", limit);
    return rows.map((r) => ({ agent: r.agent, kind: r.kind, status: r.status, detail: r.detail ?? null, at: r.at }) as RingLogEntry);
  }
}
