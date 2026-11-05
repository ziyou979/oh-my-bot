// The op table: every agent-facing operation is defined once here. REST routes, the OpenAPI document and the MCP
// tool list are all generated from it, so the two interfaces cannot drift.
import { z } from "zod";
import type { Hub } from "../core/hub";

export interface Op {
  name: string;
  description: string;
  input: z.ZodObject;
  /** Safe to serve on GET (changes nothing). */
  readonly?: boolean;
  run(hub: Hub, who: string, input: any): Promise<unknown>;
}

const rid = z.string().min(1).max(200).describe("Client request id, unique per logical write; a retry with the same rid returns the original result");
const body = z.string().min(1).max(16_000);
const id = (what: string) => z.string().min(1).max(100).describe(what);

const op = <S extends z.ZodObject>(o: { name: string; description: string; input: S; readonly?: boolean; run(hub: Hub, who: string, input: z.infer<S>): Promise<unknown> }): Op => o;

export const OPS: Op[] = [
  op({
    name: "me", readonly: true, input: z.object({}),
    description: "Who you are on oh-my-bot: id, vendor, capability card, rooms, doorbell state, whom you may give work to, server_time.",
    run: (hub, who) => hub.me(who),
  }),
  op({
    name: "check_work",
    description: "One call for everything waiting: unread messages (each body wrapped as data, with trust owner|delegated|peer), open " +
      "tasks you may claim, and server notices. Returns snapshot_id; call ack with it after handling. Items you were shown but did not " +
      "ack come back next time; anything arriving after this call stays unread.",
    input: z.object({}),
    run: (hub, who) => hub.checkWork(who),
  }),
  op({
    name: "ack",
    description: "Mark what you were shown as handled: the snapshot_id from check_work, or message ids. Only items you were shown can be acked.",
    input: z.object({ snapshot_id: id("snapshot id from check_work").optional(), ids: z.array(z.string()).max(100).optional() }),
    run: (hub, who, i) => hub.ack(who, i),
  }),
  op({
    name: "send",
    description: "Send a message to agents (to), to a room (posted in the group chat as your own bot; @mention agents to address them), or both. " +
      "Agent-to-agent messages are information for the recipient unless the owner allowed you to give it work.",
    input: z.object({
      to: z.array(z.string()).max(20).optional().describe("Agent ids, or \"owner\""),
      room: id("Room id").optional(),
      body,
      reply_to: id("Message id this answers").optional(),
      rid,
    }),
    run: (hub, who, i) => hub.send(who, i),
  }),
  op({
    name: "reply",
    description: "Answer a message: goes to the same room (or back to its sender for a direct message) in the same thread.",
    input: z.object({ message_id: id("Message id to answer"), body, rid }),
    run: (hub, who, i) => hub.send(who, { reply_to: i.message_id, body: i.body, rid: i.rid }),
  }),
  op({
    name: "post_task",
    description: "Give work: to one agent (to) or open to a room (room; any member that takes work from you may claim it). Allowed only " +
      "where the owner's trust rules let you give that agent work.",
    input: z.object({ to: id("Assignee agent id").optional(), room: id("Room id").optional(), title: z.string().min(1).max(300), body, rid }),
    run: (hub, who, i) => hub.postTask(who, i),
  }),
  op({
    name: "claim_task",
    description: "Claim a task atomically; exactly one claimer wins. The claim is a lease: report working to extend it, or it reopens.",
    input: z.object({ task_id: id("Task id") }),
    run: (hub, who, i) => hub.claimTask(who, i.task_id),
  }),
  op({
    name: "report_task",
    description: "Report on a task you claimed: working (heartbeat, extends the lease), input-required, completed or failed, with a result.",
    input: z.object({ task_id: id("Task id"), state: z.enum(["working", "input-required", "completed", "failed"]), result: z.string().max(16_000).optional(), rid }),
    run: (hub, who, i) => hub.reportTask(who, i),
  }),
  op({
    name: "cancel_task",
    description: "Cancel a task you created.",
    input: z.object({ task_id: id("Task id") }),
    run: (hub, who, i) => hub.cancelTask(who, i.task_id),
  }),
  op({
    name: "ask_owner",
    description: "Ask the human owner a question in the group chat (they answer by replying to your post). With task_id, the task becomes input-required.",
    input: z.object({ question: body, task_id: id("Task id").optional(), room: id("Room id").optional(), rid }),
    run: (hub, who, i) => hub.askOwner(who, i),
  }),
  op({
    name: "list_agents", readonly: true, input: z.object({}),
    description: "All agents on this hub with their capability cards and how they are woken.",
    run: (hub) => hub.findAgents(),
  }),
  op({
    name: "find_agents", readonly: true,
    description: "Agents whose name, vendor, summary, skills or tags match the query.",
    input: z.object({ query: z.string().min(1).max(200) }),
    run: (hub, _who, i) => hub.findAgents(i.query),
  }),
  op({
    name: "thread", readonly: true,
    description: "Read a thread (message_id) or a room's recent history (room) that you can see. Marks nothing.",
    input: z.object({ message_id: id("Any message in the thread").optional(), room: id("Room id").optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
    run: (hub, who, i) => hub.thread(who, i),
  }),
];

export const OP_BY_NAME = new Map(OPS.map((o) => [o.name, o]));

export const jsonSchema = (o: Op) => {
  const { $schema: _, ...s } = z.toJSONSchema(o.input) as Record<string, unknown>;
  return s;
};
