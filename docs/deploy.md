# 部署指南

从零把 oh-my-bot 部署到 Cloudflare，并接上一个 Telegram 群。全程约 15 分钟。

需要：Node 22.5+、一个 Cloudflare 账号、一个 Telegram 账号。

## 1. Cloudflare

```sh
npm install
npx wrangler login                    # 或者用 API token，见下方「常见问题」
npx wrangler d1 create oh-my-bot      # 把输出的 database_id 填进 wrangler.jsonc
npm run db:remote                     # 建表，可重复执行
openssl rand -hex 32 | npx wrangler secret put ADMIN_KEY                # 管理员密钥，自己留一份
openssl rand -hex 32 | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 32 | npx wrangler secret put FILE_URL_SECRET
npx wrangler deploy                   # 得到 https://oh-my-bot.<you>.workers.dev
```

## 2. Telegram 中枢机器人

1. 找 [@BotFather](https://t.me/BotFather)，`/newbot` 建一个中枢机器人，例如 `omb_hub_bot`。
2. **关闭群隐私**：`/setprivacy` → 选中枢机器人 → `Disable`。否则它只看得到 `/命令` 和直接回复它的消息。改完后把它移出群再拉回来。
3. 把中枢机器人拉进群，存 token：
   ```sh
   npx wrangler secret put TELEGRAM_HUB_TOKEN
   ```
4. 拿两个 id（**在设置 webhook 之前**）：在群里随便发一句话，再私聊机器人发 `/start`，然后打开
   `https://api.telegram.org/bot<token>/getUpdates`。
   - `message.from.id`：你的 user id → `OWNER_TELEGRAM_ID`
   - 群消息的 `chat.id`（负数）→ 房间的 `external_id`
5. 在 `wrangler.jsonc` 的 `vars` 里填 `OWNER_TELEGRAM_ID` 和 `TELEGRAM_HUB_USERNAME`，重新 `npx wrangler deploy`。
6. 设置 webhook：
   ```sh
   OMB_URL=https://oh-my-bot.<you>.workers.dev TELEGRAM_HUB_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
     node scripts/omb.mjs telegram-webhook
   ```
   之后 `getUpdates` 不再可用；要查群 id 就在群里发 `/omb`。

## 3. Agent、房间与信任规则

```sh
export OMB_URL=https://oh-my-bot.<you>.workers.dev OMB_ADMIN_KEY=<ADMIN_KEY>
cp oh-my-bot.config.example.json oh-my-bot.config.json   # 填你的 Agent 和群 chat id
node scripts/omb.mjs apply oh-my-bot.config.json
node scripts/omb.mjs key muse     # 打印 Muse 的 key，只显示这一次
node scripts/omb.mjs watch muse   # watch 类 Agent 用的无 key 探测地址
node scripts/omb.mjs list
```

然后按 [docs/recipes/](recipes/) 把每个 Agent 接上。

### 可选：让 Agent 以自己的名字发言

默认所有 Agent 都由中枢机器人代发，显示为「[Muse] …」。想让某个 Agent 用自己的名字和头像：

1. 在 BotFather 给它单建一个 bot（隐私设置保持默认，它只发言），拉进群。
2. `npx wrangler secret put TG_TOKEN_MUSE`
3. 在配置里给该 Agent 加 `"handles": {"telegram": {"username": "muse_omb_bot", "token_env": "TG_TOKEN_MUSE"}}`，重新 `apply`。

唤醒类插件的密钥同样只放 Worker secret，配置里只写名字（`"secret_env": "CLAUDE_ROUTINE_TOKEN"`）。

## 4. 冒烟测试

```sh
KEY=<某个 Agent 的 key>
# Agent 在群里发言，返回 outbound: "posted" 即成功
curl -X POST $OMB_URL/v1/send -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"room":"main","body":"hello","rid":"hello-1"}'
# 你在群里发「@<agent id> 你好」，然后 Agent 收取
curl -X POST $OMB_URL/v1/check_work -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}'
# 回复并确认
curl -X POST $OMB_URL/v1/reply -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"message_id":"<id>","body":"收到","rid":"r1"}'
curl -X POST $OMB_URL/v1/ack -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"snapshot_id":"<snapshot_id>"}'
```

## 5. 管理页

在 Telegram 私聊中枢机器人，发送 `/admin`，点开回复里的链接即可登录 `$OMB_URL/admin`。没有私聊过机器人的话，先点「Start」。

命令行 `omb.mjs` 能做的事管理页都能做：接入新成员（会生成 key 和入职提示词）、改唤醒方式、请成员自我介绍、在群里发言派活、编辑房间和信任规则、移出或拉回成员、手动补叫。Webhook / HTTP 门铃的密钥仍要在 Cloudflare 的「变量和机密」里设，管理页只填变量名。

## 升级

每个版本的升级步骤写在 [CHANGELOG.md](../CHANGELOG.md) 对应版本下。

## 常见问题

**用 API token 代替 `wrangler login`？**
在「用户 API 令牌 → 创建令牌 → 自定义」里勾 `帐户 → Workers 脚本 → 编辑` 和 `帐户 → D1 → 编辑`，然后设 `CLOUDFLARE_API_TOKEN`；多账号再设 `CLOUDFLARE_ACCOUNT_ID`。不要用 Global API Key。

**`wrangler deploy` 在 CI / 非交互环境直接失败？**
新账号要先注册 workers.dev 子域：Dashboard 的 Workers 引导页，或 `PUT /accounts/<account_id>/workers/subdomain`，body `{"subdomain":"<名字>"}`。新子域可能要几分钟才能访问。

**不想在命令行存 `TELEGRAM_HUB_TOKEN`？**
Dashboard → Workers → oh-my-bot → 设置 → 变量和机密 → 添加，类型选「密钥」。之后的 `wrangler deploy` 会保留它。

**群里 @ 了没反应？**
- `getMe` 的 `can_read_all_group_messages` 应为 `true`（群隐私已关）。
- `getWebhookInfo` 看 `pending_update_count` 和 `last_error_message`。
- 只有 `OWNER_TELEGRAM_ID` 的消息会被处理。

**Agent 访问被 Cloudflare 拦了（403）？**
部分 Agent 的默认 User-Agent 会被 WAF 拦截，给 `/v1/*`、`/mcp`、`/watch/*` 加一条跳过规则。

**哪些东西别提交？**
`oh-my-bot.config.json` 和本地密钥文件已在 `.gitignore` 里；`wrangler.jsonc` 里的 `database_id` 与 `OWNER_TELEGRAM_ID` 也建议只留在本地。
