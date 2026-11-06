// MCP over Streamable HTTP, stateless, JSON responses (no SSE, no session id). Tools come from the op table.
import { z } from "zod";
import type { Hub } from "../core/hub";
import { HubError } from "../core/types";
import { DATA_NOTICE } from "../core/util";
import { jsonSchema, OP_BY_NAME, OPS } from "./ops";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const SERVER_INFO = { name: "oh-my-bot", version: "0.2.0" };
const INSTRUCTIONS = "oh-my-bot connects you with other personal agents and the owner's group chat. Start each run with " +
  "check_work, handle the items, reply or send where useful, then ack the snapshot_id. " + DATA_NOTICE;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export const toolList = () => OPS.map((o) => ({
  name: o.name, description: o.description, inputSchema: jsonSchema(o),
  annotations: { readOnlyHint: !!o.readonly, openWorldHint: false },
}));

async function call(hub: Hub, who: string, rpc: Rpc) {
  const p = rpc.params ?? {};
  switch (rpc.method) {
    case "initialize": {
      const asked = String(p.protocolVersion ?? "");
      return ok(rpc.id, { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case "ping": return ok(rpc.id, {});
    case "tools/list": return ok(rpc.id, { tools: toolList() });
    case "tools/call": {
      const o = OP_BY_NAME.get(String(p.name));
      if (!o) return err(rpc.id, -32602, `unknown tool ${String(p.name)}`);
      try {
        const out = await o.run(hub, who, o.input.parse(p.arguments ?? {}));
        const o2 = out as { data_base64?: string; mime?: string } | null;
        if (o2?.data_base64 && o2.mime?.startsWith("image/") && !o2.mime.includes("svg")) {
          // Images also go as an MCP image block, so a model can look at them directly.
          const { data_base64, ...meta } = o2;
          return ok(rpc.id, { content: [{ type: "image", data: data_base64, mimeType: o2.mime }, { type: "text", text: JSON.stringify(meta, null, 1) }] });
        }
        return ok(rpc.id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }], structuredContent: out });
      } catch (e) {
        const msg = e instanceof HubError ? `${e.code}: ${e.message}` : e instanceof z.ZodError ? `bad arguments: ${z.prettifyError(e)}` : "internal error";
        if (!(e instanceof HubError) && !(e instanceof z.ZodError)) console.error("tool error", o.name, e);
        return ok(rpc.id, { content: [{ type: "text", text: msg }], isError: true });
      }
    }
    default: return err(rpc.id, -32601, `method not found: ${rpc.method}`);
  }
}

export async function handleMcp(hub: Hub, who: string, req: Request): Promise<Response> {
  let rpc: Rpc;
  try { rpc = (await req.json()) as Rpc; } catch { return Response.json(err(null, -32700, "parse error"), { status: 400 }); }
  if (Array.isArray(rpc) || typeof rpc?.method !== "string") return Response.json(err(null, -32600, "one JSON-RPC request per POST"), { status: 400 });
  if (rpc.id === undefined) return new Response(null, { status: 202 }); // notification
  return Response.json(await call(hub, who, rpc));
}
