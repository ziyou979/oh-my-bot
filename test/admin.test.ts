// The owner's admin page: /admin in a private chat mints a login link, the link becomes a session cookie, the cookie
// reads the overview. Links never go to a group, and a cookie alone (no X-OMB-Admin header) opens nothing.
import { describe, expect, it } from "vitest";
import { ADMIN, CHAT, OWNER_TG, setup, stores } from "./helpers";

describe.each(stores)("admin page on %s store", (_name, mk) => {
  const linkFrom = (calls: any[]) => {
    const c = calls.filter((x) => x.url.includes("/botHUBTOKEN/sendMessage")).pop();
    return /https:\/\/hub\.test\/admin\/login\?t=\S+/.exec(c?.body.text ?? "")?.[0];
  };
  const dm = (tgUpdate: any, text: string, from = OWNER_TG) => tgUpdate(text, { chat: { id: Number(from), type: "private" } }, from);

  it("/admin in a private chat sends a link; the link signs the browser in; the cookie reads the overview", async () => {
    const { tgUpdate, calls, http, op, clock } = await setup(mk());
    await op("muse", "introduce", { summary: "Meta's agent.", can: ["research"], announce: false });
    await dm(tgUpdate, "/admin");
    const link = linkFrom(calls)!;
    expect(link).toBeTruthy();
    expect(calls.filter((c) => c.url.includes("sendMessage")).pop()!.body.chat_id).toBe(OWNER_TG);

    const login = await http("GET", link.replace("https://hub.test", ""));
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const jar = cookie.split(";")[0];

    expect((await http("GET", "/admin/overview", { headers: { cookie: jar } })).status).toBe(401); // no header: a cross-site form can't use it
    const r = await http("GET", "/admin/overview", { headers: { cookie: jar, "x-omb-admin": "1" } });
    expect(r.status).toBe(200);
    const o: any = await r.json();
    expect(o.agents.find((a: any) => a.id === "muse")).toMatchObject({ intro: { summary: "Meta's agent." }, doorbell: "watch", own_bot: true });
    expect(JSON.stringify(o)).not.toContain("api2.cursor.sh"); // doorbell urls stay out
    expect(JSON.stringify(o)).not.toContain("TOKEN");
    expect((await http("GET", "/v1/me", { headers: { cookie: jar, "x-omb-admin": "1" } })).status).toBe(401); // cookie is admin-only

    clock.t += 13 * 3600_000;
    expect((await http("GET", "/admin/overview", { headers: { cookie: jar, "x-omb-admin": "1" } })).status).toBe(401);
  });

  it("a link expires after 10 minutes, and forged or group requests get nothing", async () => {
    const { tgUpdate, calls, http, clock } = await setup(mk());
    await dm(tgUpdate, "/admin");
    const link = linkFrom(calls)!.replace("https://hub.test", "");
    clock.t += 11 * 60_000;
    expect((await http("GET", link)).status).toBe(401);
    expect((await http("GET", link.slice(0, -2) + "00")).status).toBe(401);

    const before = calls.length;
    await tgUpdate("/admin"); // in the group
    const said = calls.slice(before).find((c) => c.url.includes("sendMessage"))!;
    expect(said.body.chat_id).toBe(CHAT);
    expect(said.body.text).not.toContain("/admin/login");

    const n = calls.length;
    await dm(tgUpdate, "/admin", "4242"); // not the owner
    expect(calls.length).toBe(n);
  });

  it("the page itself loads without a key and the admin key still works", async () => {
    const { http } = await setup(mk());
    const p = await http("GET", "/admin");
    expect(p.status).toBe(200);
    expect(p.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await p.text()).toContain("oh-my-bot 管理页");
    expect((await http("GET", "/admin/overview", { key: ADMIN })).status).toBe(200);
  });
});
