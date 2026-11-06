import { describe, expect, it } from "vitest";
import { parseUpdate } from "../src/channels/telegram";
import { kindOf, mimeOf } from "../src/core/files";
import { CHAT, setup, stores } from "./helpers";

const tg = (calls: { url: string; body: any }[]) => calls.filter((c) => c.url.startsWith("https://api.telegram.org/"));
const photo = [{ file_id: "small", width: 90, height: 60, file_size: 900 }, { file_id: "big", width: 1280, height: 960, file_size: 99_000 }];
const pdf = { file_id: "doc1", file_name: "报告.pdf", mime_type: "application/pdf", file_size: 52_000 };

describe("telegram files: parsing", () => {
  const base = { message_id: 7, from: { id: 1 }, chat: { id: -9, type: "group" } };
  it("keeps the largest photo size, documents, videos, voice; caption is the text; a file alone is a message", () => {
    const [ev] = parseUpdate({ update_id: 1, message: { ...base, caption: "@hark 看图", photo } });
    expect(ev.text).toBe("@hark 看图");
    expect(ev.attachments).toEqual([{ id: "a1", kind: "photo", mime: "image/jpeg", size: 99_000, width: 1280, height: 960, ref: { channel: "telegram", file_id: "big" } }]);
    const [d] = parseUpdate({ update_id: 2, message: { ...base, document: pdf } });
    expect(d.text).toBe("");
    expect(d.attachments![0]).toMatchObject({ kind: "document", name: "报告.pdf", mime: "application/pdf" });
    const [v] = parseUpdate({ update_id: 3, message: { ...base, voice: { file_id: "v", duration: 4, mime_type: "audio/ogg" }, media_group_id: "g1" } as any });
    expect(v).toMatchObject({ media_group: "g1", attachments: [{ kind: "voice", duration: 4 }] });
    // A GIF arrives as animation + document; only the animation is kept.
    const [g] = parseUpdate({ update_id: 4, message: { ...base, animation: { file_id: "an", mime_type: "video/mp4" }, document: { file_id: "an" } } as any });
    expect(g.attachments).toHaveLength(1);
    expect(parseUpdate({ update_id: 5, message: { ...base } })).toEqual([]);
  });

  it("infers kinds from names and MIME types", () => {
    expect(kindOf(mimeOf("a.png"))).toBe("photo");
    expect(kindOf(mimeOf("a.gif"))).toBe("animation");
    expect(kindOf(mimeOf("a.mp4"))).toBe("video");
    expect(kindOf(mimeOf("a.pdf"))).toBe("document");
    expect(kindOf(mimeOf("a.svg"))).toBe("document");
    expect(kindOf(mimeOf("a.mp3"))).toBe("audio");
  });
});

describe.each(stores)("files through the hub (%s store)", (_n, mk) => {
  it("owner's photo reaches the agent with a signed link; the link streams the file; others are refused", async () => {
    const { tgUpdate, op, http, calls } = await setup(mk());
    await tgUpdate("", { text: undefined, caption: "@hark 这张图里是什么", photo });
    const w = (await op("hark", "check_work")).json;
    expect(w.items).toHaveLength(1);
    const a = w.items[0].attachments[0];
    expect(a).toMatchObject({ id: "a1", kind: "photo", mime: "image/jpeg", width: 1280, message_id: w.items[0].id });
    expect(a.ref).toBeUndefined(); // the Telegram file id never leaves the hub
    expect(a.url).toMatch(/^https:\/\/hub\.test\/files\/msg_[a-f0-9]+\/a1\?a=hark&exp=\d+&sig=[a-f0-9]{64}$/);

    const r = await http("GET", a.url.replace("https://hub.test", ""));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(await r.text()).toBe("TGBYTES");
    expect(tg(calls).some((c) => c.url.endsWith("/botHUBTOKEN/getFile") && c.body.file_id === "big")).toBe(true);

    const path = new URL(a.url).pathname;
    expect((await http("GET", path)).status).toBe(401); // no key, no signature
    expect((await http("GET", a.url.replace("https://hub.test", "").replace("a=hark", "a=wabi"))).status).toBe(401); // signature is per agent
  });

  it("a non-member cannot read a room file even with its own key", async () => {
    const s = await setup(mk());
    await s.tgUpdate("", { text: undefined, caption: "@hark pdf", document: pdf });
    const item = (await s.op("hark", "check_work")).json.items[0];
    const path = `/files/${item.id}/a1`;
    expect((await s.http("GET", path, { key: s.keys.hark })).status).toBe(200);
    expect((await s.http("GET", path, { key: s.keys.wabi })).status).toBe(404);
    const g = await s.op("wabi", "get_file", { message_id: item.id, attachment_id: "a1" });
    expect(g.status).toBe(404);
  });

  it("album photos without a caption ride along with the captioned one; a quoted file comes with the reply", async () => {
    const { tgUpdate, op } = await setup(mk());
    await tgUpdate("", { text: undefined, caption: "@hark 两张图对比一下", photo, media_group_id: "alb" });
    await tgUpdate("", { text: undefined, photo: [{ file_id: "second", width: 10, height: 10 }], media_group_id: "alb" });
    const w = (await op("hark", "check_work")).json;
    expect(w.items).toHaveLength(1);
    expect(w.items[0].album_attachments).toHaveLength(1);
    expect(w.items[0].album_attachments[0]).toMatchObject({ kind: "photo", width: 10 });
    await op("hark", "ack", { snapshot_id: w.snapshot_id });

    await tgUpdate("", { text: undefined, document: pdf, message_id: 555 });
    await tgUpdate("@hark 总结一下这个 PDF", { reply_to_message: { message_id: 555, from: { id: 1001 } } });
    const w2 = (await op("hark", "check_work")).json;
    expect(w2.items).toHaveLength(1);
    expect(w2.items[0].reply_to_attachments[0]).toMatchObject({ kind: "document", name: "报告.pdf" });
  });

  it("an agent uploads bytes: posted with the caption, then stored as the bot's file id for later downloads", async () => {
    const { op, calls, hub } = await setup(mk());
    const r = await op("claude", "send", { room: "main", body: "架构图", files: [{ data_base64: btoa("PNGDATA"), name: "arch.png" }], rid: "f1" });
    expect(r.status).toBe(200);
    expect(r.json.outbound).toBe("posted");
    const post = tg(calls).find((c) => c.url.endsWith("/botHUBTOKEN/sendPhoto"))!;
    expect(post.body).toMatchObject({ chat_id: CHAT, caption: "[Claude] 架构图", photo: { blob: true, name: "arch.png", type: "image/png", size: 7 } });
    const m = await hub.store.getMessage(r.json.message.id);
    expect(m!.attachments[0]).toMatchObject({ kind: "photo", name: "arch.png", width: 900, size: 1234, ref: { channel: "telegram", file_id: expect.stringMatching(/^F/) } });
  });

  it("own bot re-sending a hub-bot file downloads and re-uploads it; a URL goes by reference, falling back to upload", async () => {
    const { tgUpdate, op, calls, fileHost, failMethods } = await setup(mk());
    await tgUpdate("", { text: undefined, caption: "@muse_omb_bot 转给大家", photo });
    const item = (await op("muse", "check_work")).json.items[0];
    await op("muse", "send", { room: "main", files: [{ from: { message_id: item.id, attachment_id: "a1" } }], rid: "m1" });
    const sent = tg(calls).find((c) => c.url.endsWith("/botMUSETOKEN/sendPhoto"))!;
    expect(sent.body.photo).toMatchObject({ blob: true }); // muse's bot cannot use the hub bot's file id
    expect(tg(calls).some((c) => c.url.endsWith("/botHUBTOKEN/getFile"))).toBe(true);

    await op("claude", "send", { room: "main", body: "see", files: [{ url: "https://example.com/report.pdf" }], rid: "u1" });
    expect(tg(calls).find((c) => c.url.endsWith("/sendDocument"))!.body).toMatchObject({ document: "https://example.com/report.pdf", caption: "[Claude] see" });

    fileHost["https://example.com/chart.png"] = "PNG";
    failMethods.add("sendPhoto");
    const r = await op("claude", "send", { room: "main", files: [{ url: "https://example.com/chart.png" }], rid: "u2" });
    expect(r.json.outbound).toBe("failed"); // both attempts answered errors in this fake
    expect(tg(calls).filter((c) => c.url.endsWith("/sendPhoto")).at(-1)!.body.photo).toMatchObject({ blob: true }); // second try uploaded
  });

  it("validates inputs: one source per file, uploads need a room, a long text goes before the files", async () => {
    const { op, calls } = await setup(mk());
    expect((await op("claude", "send", { room: "main", files: [{ url: "https://x.test/a.png", data_base64: "QQ==" }], rid: "v1" })).status).toBe(400);
    expect((await op("claude", "send", { to: ["muse"], files: [{ data_base64: "QQ==", name: "a.txt" }], rid: "v2" })).json.error).toBe("file_needs_room");
    expect((await op("claude", "send", { to: ["muse"], files: [{ url: "https://x.test/a.png" }], rid: "v3" })).status).toBe(200);
    expect((await op("claude", "send", { room: "main", rid: "v4" })).json.error).toBe("empty_body");
    expect((await op("claude", "send", { room: "main", files: [{ url: "file:///etc/passwd" }], rid: "v5" })).status).toBe(400);
    await op("claude", "send", { room: "main", body: "x".repeat(1500), files: [{ url: "https://x.test/b.mp4" }], rid: "v6" });
    const t = tg(calls);
    const text = t.findIndex((c) => c.url.endsWith("/sendMessage") && c.body.text.length > 1000);
    const vid = t.findIndex((c) => c.url.endsWith("/sendVideo"));
    expect(text).toBeGreaterThanOrEqual(0);
    expect(vid).toBeGreaterThan(text);
    expect(t[vid].body.caption).toBeUndefined();
    expect(t[vid].body.reply_parameters?.message_id).toEqual(expect.any(Number)); // the files answer the text
  });

  it("get_file inline returns base64, and MCP shows an image block", async () => {
    const { tgUpdate, op, http, keys } = await setup(mk());
    await tgUpdate("", { text: undefined, caption: "@claude look", photo });
    const item = (await op("claude", "check_work")).json.items[0];
    const g = (await op("claude", "get_file", { message_id: item.id, attachment_id: "a1", inline: true })).json;
    expect(atob(g.data_base64)).toBe("TGBYTES");
    const res = await http("POST", "/mcp", { key: keys.claude, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_file", arguments: { message_id: item.id, attachment_id: "a1", inline: true } } } });
    const j = (await res.json()) as any;
    expect(j.result.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  });
});

