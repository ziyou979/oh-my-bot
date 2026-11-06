// Self-introductions: introduce, the teammate list in check_work, and the owner's /intro command.
import { describe, expect, it } from "vitest";
import { ADMIN, setup, stores } from "./helpers";

const INTRO = {
  summary: "Meta's personal agent; good at research and summaries.",
  can: ["summarise long articles", "read images"],
  cannot: ["post on social media"],
  needs_owner_ok: ["anything that costs money"],
  response_time: "2-5 min",
  examples: ["@muse summarise this PDF"],
};

describe.each(stores)("introductions on %s store", (_name, mk) => {
  it("an agent without an intro is nudged, and gets its teammates once until the list changes", async () => {
    const { op } = await setup(mk());
    const w1 = (await op("muse", "check_work")).json;
    expect(w1.notices.join(" ")).toContain("introduce");
    expect(w1.teammates.map((t: any) => t.id).sort()).toEqual(["claude", "grok", "hark", "wabi"]);
    expect(w1.teammates.find((t: any) => t.id === "grok")).toMatchObject({ summary: "news and X search", can: ["x-search"], self_reported: false, wakes: "webhook" });
    expect(w1.teammates_notice).toContain("self-reported");
    expect((await op("muse", "check_work")).json.teammates).toBeUndefined(); // unchanged list: not sent again

    await op("grok", "introduce", { summary: "xAI's Grok.", can: ["search X in real time"] });
    const w3 = (await op("muse", "check_work")).json;
    expect(w3.teammates.find((t: any) => t.id === "grok")).toMatchObject({ summary: "xAI's Grok.", can: ["search X in real time"], self_reported: true });
  });

  it("introduce saves the intro, posts it to the agent's rooms as the agent, and stops the nudge", async () => {
    const { op, calls } = await setup(mk());
    const r = (await op("muse", "introduce", INTRO)).json;
    expect(r.posted_to).toEqual(["main"]);
    const post = calls.find((c) => c.url.includes("/botMUSETOKEN/sendMessage"))!;
    expect(post.body.text).toContain("👋 Muse: Meta's personal agent");
    expect(post.body.text).toContain("✅ read images");
    expect(post.body.text).toContain("🔐 anything that costs money");
    expect(post.body.text).toContain("⏱ 2-5 min");
    expect(post.body.text).not.toMatch(/@muse/); // @names are defanged so an intro addresses no one
    expect((await op("muse", "me")).json.intro).toMatchObject({ summary: INTRO.summary });
    expect((await op("muse", "check_work")).json.notices.join(" ")).not.toContain("introduce");
    expect((await op("hark", "check_work")).json.items).toHaveLength(0); // the intro is delivered to nobody
  });

  it("announce=false saves quietly; find_agents searches the intro", async () => {
    const { op, calls } = await setup(mk());
    await op("muse", "introduce", { ...INTRO, announce: false });
    expect(calls.some((c) => c.url.includes("sendMessage"))).toBe(false);
    const found = (await op("grok", "find_agents", { query: "pdf" })).json;
    expect(found.map((a: any) => a.id)).toEqual(["muse"]);
  });

  it("config apply keeps the agent's own intro", async () => {
    const { op, http } = await setup(mk());
    await op("muse", "introduce", { ...INTRO, announce: false });
    const put = await http("PUT", "/admin/agents/muse", { key: ADMIN, body: { name: "Muse", vendor: "meta-muse", doorbell: { kind: "watch" } } });
    expect(put.status).toBe(200);
    expect((await op("muse", "me")).json.intro.summary).toBe(INTRO.summary);
  });

  it("validates the intro", async () => {
    const { op } = await setup(mk());
    expect((await op("muse", "introduce", { summary: "x", can: [] })).status).toBe(400);
    expect((await op("owner", "introduce", INTRO)).status).toBe(400);
  });

  it("/intro asks every room member, /intro @name asks just that one", async () => {
    const { op, tgUpdate, calls } = await setup(mk());
    await tgUpdate("/intro");
    for (const id of ["muse", "grok", "claude", "hark"]) {
      const w = (await op(id, "check_work")).json;
      expect(w.items).toHaveLength(1);
      expect(w.items[0]).toMatchObject({ trust: "owner" });
      expect(w.items[0].body).toContain("introduce");
      await op(id, "ack", { snapshot_id: w.snapshot_id });
    }
    expect(calls.some((c) => c.url.includes("/botHUBTOKEN/sendMessage") && c.body.text.includes("asked muse, grok, claude, hark"))).toBe(true);

    await tgUpdate("/intro @grok");
    expect((await op("grok", "check_work")).json.items).toHaveLength(1);
    expect((await op("muse", "check_work")).json.items).toHaveLength(0);
  });
});
