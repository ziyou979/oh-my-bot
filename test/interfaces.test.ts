import { describe, expect, it } from "vitest";
import { OPS } from "../src/ops/ops";
import { ADMIN, setup } from "./helpers";

const rpc = (method: string, params: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("REST + MCP", () => {
  it("MCP: initialize, tools/list (every op), tools/call round trip, errors as isError", async () => {
    const { http, keys, op } = await setup();
    const mcp = async (body: unknown, key = keys.muse) => (await http("POST", "/mcp", { key, body })).json() as Promise<any>;
    const init = await mcp(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "oh-my-bot" } });
    expect((await http("POST", "/mcp", { key: keys.muse, body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status).toBe(202);

    const list = await mcp(rpc("tools/list", {}));
    expect(list.result.tools.map((t: any) => t.name)).toEqual(OPS.map((o) => o.name));
    const send = list.result.tools.find((t: any) => t.name === "send");
    expect(send.inputSchema).toMatchObject({ type: "object", required: ["rid"] });

    await op("owner", "send", { to: ["muse"], body: "via mcp", rid: "o1" });
    const w = await mcp(rpc("tools/call", { name: "check_work", arguments: {} }));
    expect(w.result.structuredContent.items[0].body).toContain("via mcp");
    expect(JSON.parse(w.result.content[0].text).snapshot_id).toBe(w.result.structuredContent.snapshot_id);
    const ack = await mcp(rpc("tools/call", { name: "ack", arguments: { snapshot_id: w.result.structuredContent.snapshot_id } }));
    expect(ack.result.structuredContent.unread).toBe(0);

    const bad = await mcp(rpc("tools/call", { name: "send", arguments: { body: "no rid" } }));
    expect(bad.result.isError).toBe(true);
    const unknown = await mcp(rpc("tools/call", { name: "nope", arguments: {} }));
    expect(unknown.error.code).toBe(-32602);
  });

  it("REST: 401 without or with a wrong key, 403 for admin routes with an agent key, 405 GET on writes", async () => {
    const { http, keys } = await setup();
    expect((await http("GET", "/v1/me")).status).toBe(401);
    expect((await http("GET", "/v1/me", { key: "omb_wrong" })).status).toBe(401);
    expect((await http("POST", "/mcp", { body: rpc("tools/list", {}) })).status).toBe(401);
    expect((await http("GET", "/admin/agents", { key: keys.muse })).status).toBe(403);
    expect((await http("GET", "/v1/me", { key: keys.muse })).status).toBe(200);
    expect((await http("GET", "/v1/send", { key: keys.muse })).status).toBe(405);
    expect((await http("POST", "/mcp", { key: keys.muse, body: rpc("ping", {}), headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("OpenAPI lists every op; GET works for read-only ops with query params", async () => {
    const { http, keys } = await setup();
    const doc = (await (await http("GET", "/openapi.json")).json()) as any;
    expect(Object.keys(doc.paths)).toEqual(OPS.map((o) => `/v1/${o.name}`));
    const found = (await (await http("GET", "/v1/find_agents?query=x-search", { key: keys.muse })).json()) as any[];
    expect(found.map((a) => a.id)).toEqual(["grok"]);
    expect(JSON.stringify(found)).not.toMatch(/url|secret|hash/);
  });

  it("admin: add agent, key shown once and hashed, rotate invalidates the old key", async () => {
    const { http, store } = await setup();
    const put = await http("PUT", "/admin/agents/today", { key: ADMIN, body: { name: "Today", vendor: "today", doorbell: { kind: "poll" } } });
    expect(put.status).toBe(200);
    const k1 = ((await (await http("POST", "/admin/agents/today/key", { key: ADMIN })).json()) as any).key;
    expect(k1).toMatch(/^omb_[0-9a-f]{48}$/);
    expect(JSON.stringify(await store.getAgent("today"))).not.toContain(k1);
    expect((await http("GET", "/v1/me", { key: k1 })).status).toBe(200);
    await http("POST", "/admin/agents/today/key", { key: ADMIN });
    expect((await http("GET", "/v1/me", { key: k1 })).status).toBe(401);
    expect((await http("PUT", "/admin/agents/owner", { key: ADMIN, body: { name: "x" } })).status).toBe(400);
  });

  it("watch URL reveals only {unread, latest}; bad tokens 404; agent keys are not watch tokens", async () => {
    const { http, op, keys } = await setup();
    const minted = (await (await http("POST", "/admin/agents/muse/watch", { key: ADMIN })).json()) as any;
    const path = new URL(minted.watch_url).pathname;
    expect(await (await http("GET", path)).json()).toEqual({ unread: 0, latest: null });
    const m = (await op("grok", "send", { to: ["muse"], body: "TOP SECRET BODY", rid: "x" })).json.message;
    const w = await (await http("GET", path)).json();
    expect(w).toEqual({ unread: 1, latest: m.id });
    expect(JSON.stringify(w)).not.toMatch(/SECRET|grok/);
    expect((await http("GET", `/watch/${keys.muse}`)).status).toBe(404);
    expect((await http("GET", "/watch/omw_nope")).status).toBe(404);
  });
});
