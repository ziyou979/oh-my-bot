import { describe, expect, it } from "vitest";
import { setup, type Call } from "./helpers";

const rings = (calls: Call[], host: string) => calls.filter((c) => c.url.includes(host));

describe("doorbells", () => {
  it("http (Claude routine): one ring carries full bodies; a burst inside the window coalesces into one later ring", async () => {
    const { op, calls, flush, clock, hub, store } = await setup();
    await op("owner", "send", { to: ["claude"], body: "first job", rid: "a" });
    await flush();
    const first = rings(calls, "api.anthropic.com");
    expect(first).toHaveLength(1);
    expect(first[0].headers).toMatchObject({ authorization: "Bearer claude-secret", "anthropic-version": "2023-06-01" });
    expect(first[0].body.text).toContain("first job");
    expect(first[0].body.text).toContain('<data from="owner" trust="owner">');

    for (const r of ["b", "c", "d"]) await op("owner", "send", { to: ["claude"], body: `more ${r}`, rid: r });
    await flush();
    expect(rings(calls, "api.anthropic.com")).toHaveLength(1);
    expect((await store.ringLog("claude", 10)).filter((e) => e.status === "coalesced")).toHaveLength(3);
    expect(await hub.ringer.tick()).toBe(0); // window not over yet
    clock.t += 31_000;
    expect(await hub.ringer.tick()).toBe(1);
    const second = rings(calls, "api.anthropic.com")[1];
    expect(second.body.text).toContain("4 unread");
    expect(second.body.text).toContain("more d");
  });

  it("failures back off exponentially; success resets", async () => {
    const { op, calls, flush, clock, hub, respond, store } = await setup();
    respond.status = 500;
    await op("owner", "send", { to: ["claude"], body: "x", rid: "a" });
    await flush();
    let st = (await store.getRing("claude"))!;
    expect(st.fail_count).toBe(1);
    clock.t += 30_000;
    expect(await hub.ringer.tick()).toBe(0); // backoff 60 s
    clock.t += 31_000;
    expect(await hub.ringer.tick()).toBe(1);
    st = (await store.getRing("claude"))!;
    expect(st.fail_count).toBe(2);
    expect(Date.parse(st.next_after!) - clock.t).toBe(120_000);
    respond.status = 200;
    clock.t += 121_000;
    await hub.ringer.tick();
    st = (await store.getRing("claude"))!;
    expect(st.fail_count).toBe(0);
    expect(rings(calls, "api.anthropic.com")).toHaveLength(3);
  });

  it("webhook (Grok Bot): 400 while a run is busy is retried without counting as failure", async () => {
    const { op, calls, flush, respond, store } = await setup();
    respond.status = 400;
    await op("owner", "send", { to: ["grok"], body: "news?", rid: "a" });
    await flush();
    const st = (await store.getRing("grok"))!;
    expect(st).toMatchObject({ fail_count: 0, pending: true });
    const ring = rings(calls, "api2.cursor.sh")[0];
    expect(ring.body).toMatchObject({ source: "oh-my-bot", agent: "grok", unread: 1 });
    expect(ring.body.items[0].body).toContain("news?");
  });

  it("recovers a wake the agent never answered, at most recoverMax times, and stops once it checks in", async () => {
    const { op, calls, flush, clock, hub } = await setup();
    await op("owner", "send", { to: ["claude"], body: "x", rid: "a" });
    await flush();
    for (let i = 0; i < 5; i++) { clock.t += 11 * 60_000; await hub.ringer.tick(); }
    expect(rings(calls, "api.anthropic.com")).toHaveLength(4); // first + 3 recoveries
    await op("claude", "check_work");
    clock.t += 11 * 60_000;
    expect(await hub.ringer.tick()).toBe(0);
  });

  it("rings mail whose ring was lost (e.g. the isolate died before waitUntil ran)", async () => {
    const { op, calls, hub, store } = await setup();
    hub.ringer.request = async () => {}; // the send's ring is lost
    await op("owner", "send", { to: ["claude"], body: "x", rid: "a" });
    expect(await hub.ringer.tick()).toBe(1);
    expect(rings(calls, "api.anthropic.com")).toHaveLength(1);
    expect((await store.ringLog("claude", 5)).map((e) => e.status)).toEqual(["ok", "recovered"]);
  });

  it("passive doorbells (watch, poll) never call out", async () => {
    const { op, calls, flush, store } = await setup();
    await op("owner", "send", { to: ["muse", "hark"], body: "x", rid: "a" });
    await flush();
    expect(calls.filter((c) => !c.url.includes("api.telegram.org"))).toHaveLength(0);
    expect((await store.ringLog(null, 10)).map((e) => e.status)).toEqual(["passive", "passive"]);
  });

  it("ntfy relays owner bodies in full but only a count of peer messages", async () => {
    const { op, calls, flush, clock, hub } = await setup();
    await op("owner", "send", { to: ["wabi"], body: "buy milk", rid: "a" });
    await flush();
    await op("grok", "send", { to: ["wabi"], body: "PEER SECRET INSTRUCTIONS", rid: "b" });
    clock.t += 31_000;
    await hub.ringer.tick();
    const pushes = rings(calls, "ntfy.sh/omb-test");
    expect(pushes).toHaveLength(2);
    expect(pushes[0].body).toContain("buy milk");
    expect(pushes[0].headers.title).toBe("oh-my-bot: Wabi");
    expect(pushes[1].body).not.toContain("PEER SECRET");
    expect(pushes[1].body).toContain("1 other item(s)");
  });
});
