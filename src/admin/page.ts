// The owner's admin page: one self-contained HTML file, no build step, no third-party scripts.
// Every value from the hub is written with textContent, never as HTML, so a message body cannot inject markup.

export const LOGIN_FAILED_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>oh-my-bot</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#222}</style>
<h1>登录链接已失效</h1><p>链接 10 分钟内有效。请在 Telegram 私聊中枢机器人，再发一次 <code>/admin</code>。</p></html>`;

export const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>oh-my-bot 管理页</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2129;--mute:#6b7280;--line:#e5e7eb;--acc:#2563eb;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--chip:#eef2ff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--ink:#e6e8eb;--mute:#9aa3af;--line:#2a2f37;--acc:#60a5fa;--chip:#1e2533}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--card);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:1rem;padding:.7rem 1.25rem}
header h1{font-size:16px;margin:0}header .sp{flex:1}nav{display:flex;gap:.25rem}
nav button,.btn{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:.35rem .75rem;cursor:pointer;font:inherit}
nav button[aria-current=true]{background:var(--acc);border-color:var(--acc);color:#fff}.btn:hover{border-color:var(--acc)}.btn.danger{color:var(--bad)}
main{max-width:1100px;margin:0 auto;padding:1.25rem}.mute{color:var(--mute)}.small{font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem}
.card h3{margin:0;font-size:16px;display:flex;align-items:center;gap:.5rem}.row{display:flex;flex-wrap:wrap;gap:.4rem;margin:.5rem 0}
.chip{background:var(--chip);border-radius:999px;padding:.05rem .55rem;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.list{margin:.25rem 0 .5rem;padding-left:1.1rem}.list li{margin:.1rem 0}.k{font-size:12px;color:var(--mute);margin-top:.6rem}
.msg{border-bottom:1px solid var(--line);padding:.7rem 0}.msg:last-child{border:0}.msg .body{white-space:pre-wrap;word-break:break-word;margin:.25rem 0}
.state-acked{color:var(--ok)}.state-shown{color:var(--warn)}.state-unread{color:var(--mute)}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:500}
#login{max-width:34rem;margin:12vh auto}input{width:100%;padding:.5rem;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);max-width:36rem;width:90%}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
</style>
</head>
<body>
<header>
  <h1>oh-my-bot</h1>
  <nav id="tabs" hidden>
    <button data-tab="agents" aria-current="true">成员</button>
    <button data-tab="messages">消息</button>
    <button data-tab="rings">唤醒记录</button>
    <button data-tab="trust">信任规则</button>
  </nav>
  <span class="sp"></span>
  <span id="stamp" class="mute small"></span>
  <button class="btn" id="refresh" hidden>刷新</button>
  <button class="btn" id="logout" hidden>退出</button>
</header>
<main id="app"></main>

<section id="login" class="card" hidden>
  <h2 style="margin-top:0">登录管理页</h2>
  <p>在 Telegram <b>私聊</b>中枢机器人，发送 <code>/admin</code>。它会回一个 10 分钟内有效的链接，点开即登录，这个浏览器保持 12 小时。</p>
  <p class="mute small">链接只发私聊，不会发到群里。只有配置里的主人账号能拿到。</p>
  <details><summary class="mute small">用管理员 key 登录（部署者用）</summary>
    <p><input id="keyInput" type="password" autocomplete="off" placeholder="ADMIN_KEY"></p>
    <button class="btn" id="keyGo">登录</button> <span class="mute small">只存在本标签页，关掉即清除。</span>
  </details>
</section>

<dialog id="dlg"><h3 id="dlgTitle" style="margin-top:0"></h3><div id="dlgBody"></div>
  <p style="text-align:right;margin-bottom:0"><button class="btn" id="dlgCopy" hidden>复制</button> <button class="btn" id="dlgClose">关闭</button></p></dialog>

<script>
"use strict";
const $ = (s) => document.querySelector(s);
const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) k === "class" ? (e.className = v) : k.startsWith("on") ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
};
const WAKE = { poll: "自己定时来查", watch: "门铃轮询（watch）", webhook: "中枢推送（webhook）", http: "中枢推送（HTTP）", ntfy: "中枢推送（ntfy）" };
const STATE = { unread: "未读", shown: "已取未确认", acked: "已处理" };
let data = null, tab = "agents", room = null;

function when(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d)) return s;
  const mins = Math.round((Date.now() - d) / 60000);
  const rel = mins < 1 ? "刚刚" : mins < 60 ? mins + " 分钟前" : mins < 1440 ? Math.round(mins / 60) + " 小时前" : Math.round(mins / 1440) + " 天前";
  return d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + "（" + rel + "）";
}
function headers(extra) {
  const h = Object.assign({ "x-omb-admin": "1" }, extra || {});
  const k = sessionStorage.getItem("omb_key");
  if (k) h.authorization = "Bearer " + k;
  return h;
}
async function api(method, path, body) {
  const r = await fetch(path, { method, credentials: "same-origin", headers: headers(body ? { "content-type": "application/json" } : null), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 || r.status === 403) { showLogin(); throw new Error("unauthorized"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || r.status);
  return j;
}
function showLogin() { $("#login").hidden = false; $("#app").hidden = true; $("#tabs").hidden = $("#refresh").hidden = $("#logout").hidden = true; }
function dialog(title, body, copy) {
  $("#dlgTitle").textContent = title;
  $("#dlgBody").replaceChildren(...[].concat(body));
  $("#dlgCopy").hidden = !copy;
  $("#dlgCopy").onclick = () => navigator.clipboard.writeText(copy).then(() => ($("#dlgCopy").textContent = "已复制"));
  $("#dlgCopy").textContent = "复制";
  $("#dlg").showModal();
}
$("#dlgClose").onclick = () => $("#dlg").close();

async function load() {
  try { data = await api("GET", "/admin/overview"); } catch (e) { if (e.message !== "unauthorized") alert("加载失败：" + e.message); return; }
  $("#login").hidden = true; $("#app").hidden = false; $("#tabs").hidden = $("#refresh").hidden = $("#logout").hidden = false;
  $("#stamp").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
  if (!room && data.rooms.length) room = data.rooms[0].id;
  render();
}
function render() {
  for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-current", String(b.dataset.tab === tab));
  const v = { agents, messages, rings, trust }[tab]();
  $("#app").replaceChildren(v);
}
const name = (id) => id === "owner" ? "你" : (data.agents.find((a) => a.id === id) || { name: id }).name;

function agents() {
  return el("div", { class: "grid" }, data.agents.map((a) => {
    const intro = a.intro, ring = a.ring || {}, unread = a.inbox ? a.inbox.unread : 0;
    const fails = ring.fail_count || 0;
    const color = fails ? "var(--bad)" : ring.last_check_at ? "var(--ok)" : "var(--mute)";
    const lines = (label, xs) => xs && xs.length ? [el("div", { class: "k" }, label), el("ul", { class: "list" }, xs.map((x) => el("li", null, x)))] : [];
    return el("div", { class: "card" },
      el("h3", null, el("span", { class: "dot", style: "background:" + color }), a.name, el("span", { class: "mute small" }, a.id)),
      el("div", { class: "row" },
        el("span", { class: "chip" }, a.vendor),
        el("span", { class: "chip" }, WAKE[a.doorbell] || a.doorbell),
        el("span", { class: "chip" }, a.own_bot && a.telegram ? "以 @" + a.telegram + " 发言" : "中枢代发"),
        unread ? el("span", { class: "chip", style: "color:var(--warn)" }, unread + " 条未读") : el("span", { class: "chip" }, "收件箱已清空")),
      el("div", { class: "small mute" }, "最近一次来查：" + when(ring.last_check_at)),
      fails ? el("div", { class: "small", style: "color:var(--bad)" }, "门铃连续失败 " + fails + " 次") : null,
      intro ? [
        el("p", { style: "margin:.6rem 0 0" }, intro.summary),
        ...lines("能做", intro.can), ...lines("不能做", intro.cannot), ...lines("需要你点头", intro.needs_owner_ok),
        intro.response_time ? [el("div", { class: "k" }, "响应时间"), el("div", null, intro.response_time)] : [],
        ...lines("示例", intro.examples),
        el("div", { class: "small mute", style: "margin-top:.5rem" }, "自述于 " + when(intro.updated_at)),
      ] : [el("p", { class: "mute", style: "margin:.6rem 0 0" }, "还没自我介绍。群里发 /intro @" + a.id + " 请它介绍。"),
           a.card && a.card.summary ? el("div", { class: "small" }, "配置名片：" + a.card.summary) : null],
      el("div", { class: "row", style: "margin-top:.8rem" },
        el("button", { class: "btn danger", onclick: () => reissue(a, "key") }, "重发 key"),
        a.doorbell === "watch" ? el("button", { class: "btn danger", onclick: () => reissue(a, "watch") }, "重发门铃链接") : null),
    );
  }));
}
async function reissue(a, what) {
  const label = what === "key" ? "key" : "门铃链接";
  if (!confirm("给 " + a.name + " 换一个新的" + label + "？旧的立刻失效，需要把新的填到 " + a.name + " 那边，否则它会掉线。")) return;
  try {
    const r = await api("POST", "/admin/agents/" + encodeURIComponent(a.id) + "/" + what);
    const value = what === "key" ? r.key : r.watch_url;
    dialog(a.name + " 的新" + label, [el("p", null, "只显示这一次，中枢只存了它的哈希。关掉后就看不到了。"), el("p", { class: "mono card" }, value)], value);
  } catch (e) { if (e.message !== "unauthorized") alert("失败：" + e.message); }
}

function messages() {
  const list = (data.messages[room] || []).slice().reverse();
  const pick = el("div", { class: "row" }, data.rooms.map((r) =>
    el("button", { class: "btn", style: r.id === room ? "border-color:var(--acc)" : null, onclick: () => { room = r.id; render(); } }, r.name + "（" + r.members.map(name).join("、") + "）")));
  return el("div", null, pick, el("div", { class: "card" }, list.length ? list.map((m) =>
    el("div", { class: "msg" },
      el("div", { class: "small" }, el("b", null, name(m.from)), m.to.length ? " → " + m.to.map(name).join("、") : "", el("span", { class: "mute" }, "　" + when(m.created_at)),
        m.task_id ? el("span", { class: "chip", style: "margin-left:.4rem" }, "任务") : null),
      el("div", { class: "body" }, m.body),
      m.attachments.length ? el("div", { class: "small mute" }, "📎 " + m.attachments.map((x) => x.name || x.kind).join("、")) : null,
      m.deliveries.length ? el("div", { class: "row small" }, m.deliveries.map((d) =>
        el("span", { class: "state-" + d.state }, name(d.agent) + "：" + (STATE[d.state] || d.state)))) : null)) : el("p", { class: "mute" }, "这个房间还没有消息。")));
}
function rings() {
  const ST = { ok: "已叫醒", failed: "失败", coalesced: "合并", passive: "等它来查", backoff: "退避", recovered: "补叫" };
  return el("div", { class: "card" }, el("table", null,
    el("tr", null, el("th", null, "时间"), el("th", null, "成员"), el("th", null, "方式"), el("th", null, "结果"), el("th", null, "详情")),
    data.rings.map((r) => el("tr", null, el("td", null, when(r.at)), el("td", null, name(r.agent)), el("td", null, r.kind),
      el("td", { style: r.status === "failed" ? "color:var(--bad)" : null }, ST[r.status] || r.status), el("td", { class: "small mute" }, r.detail || "")))));
}
function trust() {
  const rows = Object.entries(data.trust || {});
  return el("div", { class: "card" },
    el("p", { class: "mute", style: "margin-top:0" }, "你随时可以给任何成员派活。下面是成员之间谁能给谁派活；不在列表里的只能互相传递信息。"),
    rows.length ? el("table", null, el("tr", null, el("th", null, "成员"), el("th", null, "接受谁派的活")),
      rows.map(([k, v]) => el("tr", null, el("td", null, name(k)), el("td", null, v.map(name).join("、") || "—")))) : el("p", null, "目前没有成员之间的委派规则。"));
}

for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => { tab = b.dataset.tab; render(); };
$("#refresh").onclick = load;
$("#logout").onclick = async () => { sessionStorage.removeItem("omb_key"); await fetch("/admin/logout", { method: "POST" }); showLogin(); };
$("#keyGo").onclick = () => { sessionStorage.setItem("omb_key", $("#keyInput").value.trim()); $("#keyInput").value = ""; load(); };
setInterval(() => { if (!$("#app").hidden && !$("#dlg").open) load(); }, 60000);
load();
</script>
</body>
</html>`;
