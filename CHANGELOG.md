# Changelog

本项目的所有重要变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- 接入 Meta Muse（`watch` 唤醒），配方见 [docs/recipes/muse.md](docs/recipes/muse.md)。

## [0.2.0] - 2026-11-06

### Added
- **附件双向收发**：图片、视频、GIF、文件（PDF 等）、语音、音频、贴纸。
  - 收：说明文字即正文，照样 `@` 点名；相册合并为 `album_attachments`；引用带文件的消息时附 `reply_to_attachments`。
  - Agent 侧：`check_work` / `thread` 每条消息带 `attachments`，含按 Agent 签发、24 小时过期的下载链接。
  - 新 op `get_file`：换新链接，或 `inline: true` 直接取 base64（≤5 MB；MCP 下图片作为 image 内容块返回）。
  - 发：`send` / `reply` 支持 `files[]`，每项为 `url`、`data_base64`（≤20 MB，仅限房间）或 `from`（转发看到的附件）。
- 新 Worker secret `FILE_URL_SECRET`，用于签名下载链接。
- `migrations/0002_attachments.sql`。

### Changed
- 中枢只存 Telegram file_id 或原始 URL，不存文件本体；换 bot 转发时自动下载并重新上传。

### Security
- file_id 与 bot token 不出现在 Agent 可见的任何字段里；SVG / HTML / XML 一律以下载方式返回，不在中枢域名下渲染。

### 升级
```sh
npx wrangler d1 execute oh-my-bot --remote --file migrations/0002_attachments.sql
openssl rand -hex 32 | npx wrangler secret put FILE_URL_SECRET   # 可选，不设则由 TELEGRAM_WEBHOOK_SECRET 派生
npx wrangler deploy
```

## [0.1.0] - 2026-11-06

首个版本，并完成第一次线上部署（群 → 中枢 → Agent → 中枢 → 群）。

### Added
- 中枢：Cloudflare Worker + D1，内存 Store 用于测试。
- 两阶段投递：`check_work` 返回快照，`ack` 才算送达；未 ack 的消息会重新投递。
- 一张 op 表同时生成 REST（`/v1/<op>`）、OpenAPI（`/openapi.json`）和 MCP（`/mcp`）。
- Telegram 通道：一个中枢机器人收发全部消息；Agent 可选配自己的 bot 以自己的名字发言。
- 唤醒插件：`http`、`webhook`、`watch`、`poll`、`ntfy`；合并、退避、补响，每分钟 cron 兜底。
- 任务层：`post_task` / `claim_task` / `report_task` / `cancel_task`，原子认领 + 租约。
- 信任与防循环：只有 owner 默认可派活；跳数上限、同对限速、重复抑制。
- 管理 CLI `scripts/omb.mjs` 与本地端到端冒烟 `npm run e2e`。

[Unreleased]: https://github.com/ziyou979/oh-my-bot/compare/cc78fb2...HEAD
[0.2.0]: https://github.com/ziyou979/oh-my-bot/compare/9c5db25...cc78fb2
[0.1.0]: https://github.com/ziyou979/oh-my-bot/commits/9c5db25
