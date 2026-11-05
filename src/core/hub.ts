// The hub: routing, two-phase delivery, trust, loop guard and tasks. Every frontend (REST, MCP, chat channels)
// goes through these methods, so the rules live in exactly one place.
import type { ChannelAdapter, Doorbell, HubEnv, InboundEvent } from "./plugins";
import { Ringer, type RingSettings } from "./ringer";
import type { Store } from "./store";
import { HubError, OWNER, TERMINAL, type Agent, type Message, type Task, type TaskState, type Trust, type TrustRules } from "./types";
import { DATA_NOTICE, iso, randomId, sha256, wrapData } from "./util";

export interface HubSettings extends RingSettings {
  maxHops: number;
  pairLimitPerMin: number; // messages from one agent to one recipient per minute
  dupWindowMs: number; // identical body from the same sender to the same target is suppressed inside this window
  leaseMs: number; // task claim lease
  checkLimit: number; // items per check_work
  maxBody: number;
  /** channel -> the owner's user id there. Only the owner can give work from a chat app. */
  owners: Record<string, string>;
  notice?: string;
}

export const DEFAULTS: HubSettings = {
  maxHops: 6, pairLimitPerMin: 8, dupWindowMs: 10 * 60_000, leaseMs: 15 * 60_000, checkLimit: 20, maxBody: 16_000,
  owners: {}, coalesceMs: 30_000, backoffBaseMs: 60_000, backoffCapMs: 60 * 60_000, recoverAfterMs: 10 * 60_000,
  recoverMax: 3, previewItems: 5,
};

export interface SendInput {
  to?: string[]; // agent ids, or "owner"
  room?: string;
  body: string;
  rid: string;
  reply_to?: string;
  task_id?: string;
}

export interface SendResult { message: Message; duplicate: boolean; suppressed?: boolean; outbound?: "posted" | "failed" | "none" }

const MENTION = /@([A-Za-z0-9_]{2,64})/g;

export class Hub {
  readonly ringer: Ringer;
  /** Work started by a request that may finish after the response (Workers: ctx.waitUntil). */
  defer: (p: Promise<unknown>) => void = (p) => void p.catch((e) => console.error("deferred", e));

  constructor(
    readonly store: Store,
    readonly env: HubEnv,
    readonly doorbells: Record<string, Doorbell>,
    readonly channels: Record<string, ChannelAdapter>,
    readonly s: HubSettings = DEFAULTS,
  ) {
    this.ringer = new Ringer(store, doorbells, env, s);
  }

  private now = () => iso(this.env.now());

  // ---------- identity ----------

  async authAgent(key: string): Promise<string | null> {
    return key.startsWith("omb_") ? this.store.agentByKeyHash(await sha256(key)) : null;
  }

  async mintKey(agent: string): Promise<string> {
    await this.mustAgent(agent);
    const key = randomId("omb_", 24);
    await this.store.setKeyHash(agent, await sha256(key));
    return key;
  }

  async mintWatch(agent: string): Promise<string> {
    await this.mustAgent(agent);
    const tok = randomId("omw_", 24);
    await this.store.setWatchHash(agent, await sha256(tok));
    return tok;
  }

  /** Keyless watch URL for model-free hook detectors: counts and an opaque latest id, nothing else. */
  async watch(token: string): Promise<{ unread: number; latest: string | null } | null> {
    const agent = token.startsWith("omw_") ? await this.store.agentByWatchHash(await sha256(token)) : null;
    if (!agent) return null;
    const { unread, latest } = await this.store.unreadSummary(agent);
    return { unread, latest };
  }

  private async mustAgent(id: string): Promise<Agent> {
    const a = await this.store.getAgent(id);
    if (!a) throw new HubError(404, "no_such_agent", `no agent ${id}`);
    return a;
  }

  private async roomsOf(agent: string) {
    return (await this.store.listRooms()).filter((r) => agent === OWNER || r.members.includes(agent));
  }

  async me(who: string) {
    if (who === OWNER) return { id: OWNER, role: "owner", server_time: this.now() };
    const a = await this.mustAgent(who);
    const ring = await this.store.getRing(who);
    return {
      id: a.id, name: a.name, vendor: a.vendor, card: a.card, rooms: (await this.roomsOf(who)).map((r) => r.id),
      doorbell: { kind: a.doorbell.kind, failing: (ring?.fail_count ?? 0) > 0, next_after: ring?.next_after ?? null },
      may_give_work_to: Object.entries(await this.store.getTrust()).filter(([, s]) => s.includes(who)).map(([r]) => r),
      server_time: this.now(),
    };
  }

  /** Public directory entries: never keys, URLs or secrets. */
  async findAgents(query?: string) {
    const q = query?.toLowerCase().trim();
    return (await this.store.listAgents())
      .filter((a) => !q || [a.id, a.name, a.vendor, a.card.summary, ...a.card.skills, ...(a.card.tags ?? [])].join(" ").toLowerCase().includes(q))
      .map((a) => ({ id: a.id, name: a.name, vendor: a.vendor, card: a.card, doorbell: a.doorbell.kind }));
  }

  // ---------- trust ----------

  async trustFor(from: string, recipient: string, rules?: TrustRules): Promise<Trust> {
    if (from === OWNER) return "owner";
    rules ??= await this.store.getTrust();
    return rules[recipient]?.includes(from) ? "delegated" : "peer";
  }

  // ---------- messages ----------

  /** Resolve @names (agent id, alias or a channel username) to agent ids. */
  async mentions(text: string): Promise<string[]> {
    const names = new Map<string, string>();
    for (const a of await this.store.listAgents()) {
      for (const n of [a.id, ...(a.aliases ?? []), ...Object.values(a.handles).map((h) => h.username)]) names.set(n.toLowerCase(), a.id);
    }
    const out = new Set<string>();
    for (const m of text.matchAll(MENTION)) { const id = names.get(m[1].toLowerCase()); if (id) out.add(id); }
    return [...out];
  }

  async canSee(who: string, m: Message): Promise<boolean> {
    if (who === OWNER || m.from === who) return true;
    if ((await this.store.deliveriesFor(m.id)).some((d) => d.agent === who)) return true;
    if (!m.room) return false;
    return !!(await this.store.getRoom(m.room))?.members.includes(who);
  }

  async send(from: string, inp: SendInput, opts: { mirror?: boolean; external_id?: string } = {}): Promise<SendResult> {
    const body = inp.body.trim();
    if (!body) throw new HubError(400, "empty_body");
    if (body.length > this.s.maxBody) throw new HubError(413, "body_too_long");
    if (!inp.rid) throw new HubError(400, "rid_required", "every write carries a client request id (rid)");

    const parent = inp.reply_to ? await this.store.getMessage(inp.reply_to) : null;
    if (inp.reply_to && (!parent || !(await this.canSee(from, parent)))) throw new HubError(404, "no_such_message");

    const roomId = inp.room ?? (inp.to?.length ? null : parent?.room ?? null);
    const room = roomId ? await this.store.getRoom(roomId) : null;
    if (roomId && !room) throw new HubError(404, "no_such_room");
    if (room && from !== OWNER && !room.members.includes(from)) throw new HubError(403, "not_a_member");

    // Recipients: explicit, @mentions (room members only), and the author of the message being answered.
    const to = new Set(inp.to ?? []);
    for (const id of await this.mentions(body)) if (!room || room.members.includes(id)) to.add(id);
    // (The owner reads rooms in the chat app itself, so a room reply does not also fill the owner's hub inbox.)
    if (parent && !inp.to?.length && parent.from !== from && !(room && parent.from === OWNER)) to.add(parent.from);
    to.delete(from);
    for (const id of to) if (id !== OWNER) await this.mustAgent(id);
    if (!room && !to.size) throw new HubError(400, "no_recipient", "give to, room, or reply_to");

    const hop = from === OWNER ? 0 : parent ? parent.hop + 1 : ((await this.store.latestSnapshot(from))?.max_hop ?? 0) + 1;
    const body_hash = await sha256(body);
    if (from !== OWNER) {
      const dup = await this.loopGuard(from, hop, body_hash, [...to], room?.id ?? null, inp.rid);
      if (dup) return { message: dup, duplicate: true, suppressed: true, outbound: "none" };
    }

    const rules = await this.store.getTrust();
    const deliveries = await Promise.all([...to].map(async (agent) => ({ agent, trust: await this.trustFor(from, agent, rules) })));
    const msg: Message = {
      id: randomId("msg_"), from, room: room?.id ?? null, to: [...to], body, reply_to: parent?.id ?? null,
      thread_id: parent?.thread_id ?? "", rid: inp.rid, hop, task_id: inp.task_id ?? parent?.task_id ?? null, body_hash,
      external_id: opts.external_id ?? null, created_at: this.now(),
    };
    msg.thread_id ||= msg.id;
    const { message, inserted } = await this.store.insertMessage(msg, deliveries);
    if (!inserted) return { message, duplicate: true };

    let outbound: SendResult["outbound"] = "none";
    if (room && opts.mirror !== false) outbound = await this.mirror(message, parent);
    for (const d of deliveries) this.defer(this.ringer.request(d.agent));
    return { message, duplicate: false, outbound };
  }

  /** Returns the earlier message when this one is a duplicate to suppress; throws on hop or rate limits. */
  private async loopGuard(from: string, hop: number, hash: string, to: string[], room: string | null, rid: string) {
    if (hop > this.s.maxHops) throw new HubError(409, "hop_limit", `hop ${hop} exceeds ${this.s.maxHops}; the chain stops here`);
    const now = this.env.now();
    const recent = await this.store.recentFrom(from, iso(now - Math.max(this.s.dupWindowMs, 60_000)));
    const target = (m: Message) => `${m.room}|${[...m.to].sort().join(",")}`;
    const dup = recent.find((m) => m.rid !== rid && m.body_hash === hash && target(m) === `${room}|${[...to].sort().join(",")}`
      && now - Date.parse(m.created_at) < this.s.dupWindowMs);
    if (dup) return dup;
    const lastMin = recent.filter((m) => m.rid !== rid && now - Date.parse(m.created_at) < 60_000);
    for (const r of to) {
      if (lastMin.filter((m) => m.to.includes(r)).length >= this.s.pairLimitPerMin)
        throw new HubError(429, "rate_limited", `too many messages from ${from} to ${r} in the last minute`);
    }
    return null;
  }

  private async mirror(m: Message, parent: Message | null): Promise<"posted" | "failed" | "none"> {
    const room = await this.store.getRoom(m.room!);
    const ch = room && this.channels[room.channel];
    if (!room || !ch) return "none";
    const agent = m.from === OWNER ? null : await this.store.getAgent(m.from);
    try {
      const ext = await ch.post({ room, agent, text: m.from === OWNER ? `owner: ${m.body}` : m.body, reply_to_external: parent?.external_id }, this.env);
      if (ext) await this.store.setExternalId(m.id, ext);
      return "posted";
    } catch (e) {
      console.error("mirror failed", room.channel, String(e).slice(0, 200));
      return "failed";
    }
  }

  /** A chat app delivered a message. Only the owner can address agents; everyone else is ignored. */
  async ingest(ev: InboundEvent): Promise<{ routed: string[]; ignored?: string }> {
    const room = await this.store.roomByExternal(ev.channel, ev.external_room);
    const ch = this.channels[ev.channel];
    if (ev.sender_external !== this.s.owners[ev.channel]) return { routed: [], ignored: "not_owner" };
    if (ev.command === "omb") {
      const text = room ? `oh-my-bot: this chat is room "${room.id}" (${room.members.join(", ")})` : `oh-my-bot: unbound chat id ${ev.external_room}`;
      if (ch) await ch.post({ room: room ?? { id: "", name: "", channel: ev.channel, external_id: ev.external_room, members: [] }, agent: null, text }, this.env);
      return { routed: [], ignored: "command" };
    }
    if (!room) return { routed: [], ignored: "unbound_room" };
    const parent = ev.reply_to_external ? await this.store.messageByExternal(room.id, ev.reply_to_external) : null;
    const to = new Set<string>();
    if (ev.reply_to_username) for (const id of await this.mentions("@" + ev.reply_to_username)) to.add(id);
    const r = await this.send(OWNER, { room: room.id, body: ev.text, rid: `${ev.channel}:${ev.external_room}:${ev.external_id}`,
      reply_to: parent?.id, to: to.size ? [...to] : undefined }, { mirror: false, external_id: ev.external_id });
    if (!r.duplicate && parent?.task_id) {
      const t = await this.store.getTask(parent.task_id);
      if (t?.state === "input-required") await this.store.updateTask(t.id, "input-required", { state: "working", updated_at: this.now() });
    }
    return { routed: r.message.to };
  }

  // ---------- two-phase delivery ----------

  /** One call: unread mail, open tasks and notices. Everything shown belongs to the returned snapshot;
   *  only ack(snapshot_id) marks it handled. Mail arriving after the snapshot stays unread. */
  async checkWork(who: string) {
    const items = await this.store.pending(who, this.s.checkLimit);
    const snapshot_id = items.length ? randomId("snap_") : null;
    if (snapshot_id)
      await this.store.saveSnapshot({ id: snapshot_id, agent: who, message_ids: items.map((i) => i.message.id),
        max_hop: Math.max(...items.map((i) => i.message.hop)), created_at: this.now() });
    const ring = who === OWNER ? null : await this.ringer.checked(who);
    const tasks = await this.visibleTasks(who);
    const notices: string[] = [];
    if (this.s.notice) notices.push(this.s.notice);
    if (ring && ring.fail_count > 0) notices.push(`Your doorbell failed ${ring.fail_count} time(s); the owner should check it.`);
    const { unread } = await this.store.unreadSummary(who);
    if (unread > items.length) notices.push(`${unread - items.length} more item(s) waiting: ack this snapshot, then call check_work again.`);
    return {
      snapshot_id,
      notice: DATA_NOTICE,
      items: items.map(({ message: m, delivery: d }) => ({
        id: m.id, from: m.from, room: m.room, trust: d.trust, thread_id: m.thread_id, reply_to: m.reply_to, task_id: m.task_id,
        hop: m.hop, created_at: m.created_at, redelivered: d.state === "shown", body: wrapData(m.from, d.trust, m.body),
      })),
      tasks: tasks.map((t) => ({ ...t, body: wrapData(t.created_by, "task", t.body), title: wrapData(t.created_by, "task", t.title) })),
      notices,
      server_time: this.now(),
    };
  }

  async ack(who: string, inp: { snapshot_id?: string; ids?: string[] }) {
    let ids = inp.ids ?? [];
    if (inp.snapshot_id) {
      const snap = await this.store.getSnapshot(inp.snapshot_id);
      if (!snap || snap.agent !== who) throw new HubError(404, "no_such_snapshot");
      ids = [...ids, ...snap.message_ids];
    }
    if (!ids.length) throw new HubError(400, "nothing_to_ack", "give snapshot_id or ids");
    const acked = await this.store.ack(who, ids, this.now());
    return { acked, unread: (await this.store.unreadSummary(who)).unread };
  }

  async thread(who: string, inp: { message_id?: string; room?: string; limit?: number }) {
    const limit = Math.min(inp.limit ?? 50, 200);
    let msgs: Message[];
    if (inp.message_id) {
      const m = await this.store.getMessage(inp.message_id);
      if (!m || !(await this.canSee(who, m))) throw new HubError(404, "no_such_message");
      msgs = await this.store.listThread(m.thread_id, limit);
    } else if (inp.room) {
      const r = await this.store.getRoom(inp.room);
      if (!r || (who !== OWNER && !r.members.includes(who))) throw new HubError(404, "no_such_room");
      msgs = await this.store.listRoom(r.id, limit);
    } else throw new HubError(400, "give message_id or room");
    const visible = [];
    for (const m of msgs) if (await this.canSee(who, m)) visible.push(m);
    return {
      notice: DATA_NOTICE,
      messages: visible.map((m) => ({ id: m.id, from: m.from, room: m.room, to: m.to, reply_to: m.reply_to, task_id: m.task_id,
        hop: m.hop, created_at: m.created_at, body: wrapData(m.from, "history", m.body) })),
    };
  }

  // ---------- tasks (optional layer on messages, A2A-style states) ----------

  private async eligible(t: Task, agent: string, rules: TrustRules): Promise<boolean> {
    if (t.assignee) return t.assignee === agent;
    const room = t.room ? await this.store.getRoom(t.room) : null;
    return !!room?.members.includes(agent) && agent !== t.created_by && (await this.trustFor(t.created_by, agent, rules)) !== "peer";
  }

  private async visibleTasks(who: string): Promise<Task[]> {
    if (who === OWNER) return [];
    const rules = await this.store.getTrust();
    const now = this.now();
    const out: Task[] = [];
    for (const t of await this.store.openTasksFor(who, (await this.roomsOf(who)).map((r) => r.id))) {
      if (!(await this.eligible(t, who, rules))) continue;
      const free = t.state === "submitted" || (t.state === "working" && (t.lease_until ?? "") < now);
      if (t.claimed_by === who || free) out.push(t);
    }
    return out;
  }

  async postTask(from: string, inp: { to?: string; room?: string; title: string; body: string; rid: string }) {
    if (!inp.to === !inp.room) throw new HubError(400, "give exactly one of to or room");
    const rules = await this.store.getTrust();
    let recipients: string[];
    if (inp.to) {
      await this.mustAgent(inp.to);
      if ((await this.trustFor(from, inp.to, rules)) === "peer") throw new HubError(403, "not_allowed", `${from} may not give work to ${inp.to}`);
      recipients = [inp.to];
    } else {
      const room = await this.store.getRoom(inp.room!);
      if (!room) throw new HubError(404, "no_such_room");
      if (from !== OWNER && !room.members.includes(from)) throw new HubError(403, "not_a_member");
      recipients = [];
      for (const m of room.members) if (m !== from && (await this.trustFor(from, m, rules)) !== "peer") recipients.push(m);
      if (!recipients.length) throw new HubError(403, "not_allowed", `nobody in ${room.id} takes work from ${from}`);
    }
    const id = randomId("tsk_");
    const sent = await this.send(from, { to: recipients, room: inp.room, body: `[task ${id}] ${inp.title}\n\n${inp.body}`, rid: `task:${inp.rid}`, task_id: id });
    const now = this.now();
    const { task } = await this.store.insertTask({
      id, title: inp.title, body: inp.body, created_by: from, assignee: inp.to ?? null, room: inp.room ?? null, state: "submitted",
      claimed_by: null, lease_until: null, result: null, rid: inp.rid, message_id: sent.message.id, created_at: now, updated_at: now,
    });
    return { task };
  }

  async claimTask(who: string, taskId: string) {
    if (who === OWNER) throw new HubError(403, "owner_cannot_claim");
    const t = await this.store.getTask(taskId);
    if (!t || !(await this.eligible(t, who, await this.store.getTrust()))) throw new HubError(404, "no_such_task");
    const now = this.env.now();
    const won = await this.store.claimTask(taskId, who, iso(now), iso(now + this.s.leaseMs));
    if (!won) throw new HubError(409, "already_claimed", `task is ${t.state}${t.claimed_by ? ` by ${t.claimed_by}` : ""}`);
    return { task: won };
  }

  async reportTask(who: string, inp: { task_id: string; state: "working" | "input-required" | "completed" | "failed"; result?: string; rid: string }) {
    const t = await this.store.getTask(inp.task_id);
    if (!t) throw new HubError(404, "no_such_task");
    if (t.claimed_by !== who) throw new HubError(403, "not_your_task", "claim the task first");
    if (TERMINAL.includes(t.state)) throw new HubError(409, "task_closed", `task is ${t.state}`);
    const now = this.env.now();
    const task = await this.store.updateTask(t.id, t.state, { state: inp.state, result: inp.result ?? t.result, updated_at: iso(now),
      lease_until: inp.state === "working" ? iso(now + this.s.leaseMs) : t.lease_until });
    if (!task) throw new HubError(409, "task_changed", "the task changed under you; read it again");
    let report: string = "none";
    if (inp.state !== "working" || inp.result) {
      try {
        const to = t.created_by === OWNER && t.room ? undefined : [t.created_by];
        await this.send(who, { reply_to: t.message_id, to, body: `[task ${t.id} ${inp.state}] ${inp.result ?? ""}`.trim(), rid: `report:${inp.rid}` });
        report = "sent";
      } catch (e) {
        report = e instanceof HubError ? `suppressed: ${e.code}` : "failed";
      }
    }
    return { task, report };
  }

  async cancelTask(who: string, taskId: string) {
    const t = await this.store.getTask(taskId);
    if (!t || (who !== OWNER && t.created_by !== who)) throw new HubError(404, "no_such_task");
    if (TERMINAL.includes(t.state)) return { task: t };
    const task = await this.store.updateTask(t.id, t.state, { state: "canceled" as TaskState, updated_at: this.now() });
    if (!task) throw new HubError(409, "task_changed");
    return { task };
  }

  /** Ask the human owner. Posted in the task's room (or the agent's first room) so the owner can answer by replying. */
  async askOwner(who: string, inp: { question: string; task_id?: string; room?: string; rid: string }) {
    if (who === OWNER) throw new HubError(400, "you_are_the_owner");
    let t: Task | null = null;
    if (inp.task_id) {
      t = await this.store.getTask(inp.task_id);
      if (!t || t.claimed_by !== who) throw new HubError(403, "not_your_task");
    }
    const room = inp.room ?? t?.room ?? (await this.roomsOf(who))[0]?.id;
    const r = await this.send(who, { to: [OWNER], room, body: `❓ ${inp.question}`, rid: `ask:${inp.rid}`, task_id: t?.id,
      reply_to: t && !room ? t.message_id : undefined });
    if (t && !TERMINAL.includes(t.state) && t.state !== "input-required")
      await this.store.updateTask(t.id, t.state, { state: "input-required", updated_at: this.now() });
    return { message_id: r.message.id, room: r.message.room, outbound: r.outbound };
  }
}
