// In-memory Store. JavaScript runs one microtask at a time and no method awaits mid-update, so every method is atomic.
import type { PendingItem, Store } from "./store";
import type { Agent, Delivery, Message, RingLogEntry, RingState, Room, Snapshot, Task, Trust, TrustRules } from "./types";
import { TERMINAL } from "./types";

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  private agents = new Map<string, Agent>();
  private keys = new Map<string, string>(); // hash -> agent
  private watch = new Map<string, string>();
  private rooms = new Map<string, Room>();
  private trust: TrustRules = {};
  private messages = new Map<string, Message>();
  private deliveries: Delivery[] = [];
  private snapshots = new Map<string, Snapshot>();
  private tasks = new Map<string, Task>();
  private rings = new Map<string, RingState>();
  private log: RingLogEntry[] = [];

  async getAgent(id: string) { return this.agents.has(id) ? clone(this.agents.get(id)!) : null; }
  async listAgents() { return [...this.agents.values()].map(clone).sort((a, b) => a.id.localeCompare(b.id)); }
  async putAgent(a: Agent) { this.agents.set(a.id, clone(a)); }
  async setKeyHash(agent: string, hash: string) { this.replace(this.keys, agent, hash); }
  async agentByKeyHash(hash: string) { return this.keys.get(hash) ?? null; }
  async setWatchHash(agent: string, hash: string) { this.replace(this.watch, agent, hash); }
  async agentByWatchHash(hash: string) { return this.watch.get(hash) ?? null; }
  private replace(m: Map<string, string>, agent: string, hash: string) {
    for (const [h, a] of m) if (a === agent) m.delete(h);
    m.set(hash, agent);
  }

  async getRoom(id: string) { return this.rooms.has(id) ? clone(this.rooms.get(id)!) : null; }
  async roomByExternal(channel: string, ext: string) {
    const r = [...this.rooms.values()].find((x) => x.channel === channel && x.external_id === ext);
    return r ? clone(r) : null;
  }
  async listRooms() { return [...this.rooms.values()].map(clone); }
  async putRoom(r: Room) { this.rooms.set(r.id, clone(r)); }
  async getTrust() { return clone(this.trust); }
  async putTrust(t: TrustRules) { this.trust = clone(t); }

  async insertMessage(m: Message, ds: { agent: string; trust: Trust }[]) {
    const dup = [...this.messages.values()].find((x) => x.from === m.from && x.rid === m.rid);
    if (dup) return { message: clone(dup), inserted: false };
    this.messages.set(m.id, clone(m));
    for (const d of ds)
      this.deliveries.push({ message_id: m.id, agent: d.agent, state: "unread", trust: d.trust, snapshot_id: null, created_at: m.created_at, acked_at: null });
    return { message: clone(m), inserted: true };
  }
  async getMessage(id: string) { return this.messages.has(id) ? clone(this.messages.get(id)!) : null; }
  async messageByExternal(room: string, ext: string) {
    const m = [...this.messages.values()].find((x) => x.room === room && x.external_id === ext);
    return m ? clone(m) : null;
  }
  async setExternalId(id: string, ext: string) { const m = this.messages.get(id); if (m) m.external_id = ext; }
  private byTime(filter: (m: Message) => boolean, limit: number) {
    return [...this.messages.values()].filter(filter).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-limit).map(clone);
  }
  async listThread(threadId: string, limit: number) { return this.byTime((m) => m.thread_id === threadId, limit); }
  async listRoom(roomId: string, limit: number) { return this.byTime((m) => m.room === roomId, limit); }
  async recentFrom(from: string, since: string) {
    return this.byTime((m) => m.from === from && m.created_at >= since, 1000).reverse();
  }
  async deliveriesFor(messageId: string) { return this.deliveries.filter((d) => d.message_id === messageId).map(clone); }

  async pending(agent: string, limit: number): Promise<PendingItem[]> {
    return this.deliveries
      .filter((d) => d.agent === agent && d.state !== "acked")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit)
      .map((d) => ({ delivery: clone(d), message: clone(this.messages.get(d.message_id)!) }));
  }
  async saveSnapshot(s: Snapshot) {
    this.snapshots.set(s.id, clone(s));
    for (const d of this.deliveries)
      if (d.agent === s.agent && d.state !== "acked" && s.message_ids.includes(d.message_id)) { d.state = "shown"; d.snapshot_id = s.id; }
  }
  async getSnapshot(id: string) { return this.snapshots.has(id) ? clone(this.snapshots.get(id)!) : null; }
  async latestSnapshot(agent: string) {
    const all = [...this.snapshots.values()].filter((s) => s.agent === agent).sort((a, b) => a.created_at.localeCompare(b.created_at));
    return all.length ? clone(all[all.length - 1]) : null;
  }
  async ack(agent: string, ids: string[], now: string) {
    const out: string[] = [];
    for (const d of this.deliveries)
      if (d.agent === agent && d.state === "shown" && ids.includes(d.message_id)) { d.state = "acked"; d.acked_at = now; out.push(d.message_id); }
    return out;
  }
  async unreadSummary(agent: string) {
    const ds = this.deliveries.filter((d) => d.agent === agent && d.state !== "acked").sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { unread: ds.length, latest: ds.length ? ds[ds.length - 1].message_id : null, oldest_at: ds.length ? ds[0].created_at : null };
  }

  async insertTask(t: Task) {
    const dup = [...this.tasks.values()].find((x) => x.created_by === t.created_by && x.rid === t.rid);
    if (dup) return { task: clone(dup), inserted: false };
    this.tasks.set(t.id, clone(t));
    return { task: clone(t), inserted: true };
  }
  async getTask(id: string) { return this.tasks.has(id) ? clone(this.tasks.get(id)!) : null; }
  async claimTask(id: string, agent: string, now: string, leaseUntil: string) {
    const t = this.tasks.get(id);
    if (!t) return null;
    const free = t.state === "submitted" || (t.state === "working" && (t.claimed_by === agent || (t.lease_until ?? "") < now));
    if (!free) return null;
    Object.assign(t, { state: "working", claimed_by: agent, lease_until: leaseUntil, updated_at: now });
    return clone(t);
  }
  async updateTask(id: string, expect: Task["state"], patch: Partial<Task>) {
    const t = this.tasks.get(id);
    if (!t || t.state !== expect) return null;
    Object.assign(t, patch);
    return clone(t);
  }
  async openTasksFor(agent: string, rooms: string[]) {
    return [...this.tasks.values()]
      .filter((t) => !TERMINAL.includes(t.state) && (t.assignee === agent || (t.assignee === null && t.room !== null && rooms.includes(t.room))))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).map(clone);
  }

  async getRing(agent: string) { return this.rings.has(agent) ? clone(this.rings.get(agent)!) : null; }
  async putRing(s: RingState) { this.rings.set(s.agent, clone(s)); }
  async logRing(e: RingLogEntry) { this.log.push(clone(e)); }
  async ringLog(agent: string | null, limit: number) {
    return this.log.filter((e) => !agent || e.agent === agent).slice(-limit).reverse().map(clone);
  }
}
