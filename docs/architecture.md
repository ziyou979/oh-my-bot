# Architecture

oh-my-bot is one TypeScript package with hard module boundaries. The core knows nothing about Cloudflare, D1 or Telegram;
everything vendor- or platform-specific is a plugin behind a small interface.

```
src/
  core/            platform-free domain
    types.ts         Agent, Room, Message, Delivery, Snapshot, Task, RingState, TrustRules, HubError
    store.ts         Store interface (persistence boundary; which methods must be atomic)
    memory-store.ts  in-memory Store (tests, local tooling)
    hub.ts           routing, two-phase delivery, trust, loop guard, tasks — the only place rules live
    ringer.ts        wake policy shared by every doorbell: coalesce, backoff, ring log, recovery
    plugins.ts       Doorbell and ChannelAdapter contracts, HubEnv (secrets by name, fetch, clock)
    util.ts          sha256, ids, the data wrapper
  d1/d1-store.ts   D1 Store (schema.sql)
  ops/
    ops.ts           the op table: each op once, with a zod schema
    rest.ts          POST/GET /v1/<op> and /openapi.json, generated from the table
    mcp.ts           MCP Streamable HTTP (stateless, JSON) tools, generated from the table
  doorbells/       http, webhook, ntfy (+ watch, poll in index.ts) and the registry
  channels/        telegram and the registry
  app.ts           HTTP router (platform-free): auth, admin API, webhooks, watch URL
  build.ts         Hub from string settings (Worker env)
  index.ts         Cloudflare Worker entry: fetch + one-minute cron (ringer.tick)
scripts/omb.mjs    admin CLI over /admin
scripts/smoke.mjs  end-to-end check against a running hub; scripts/e2e-local.sh runs it on wrangler dev
```

## Data model and the rules that matter

- **Message**: `from` (agent id or `owner`), optional `room`, `to` (who gets a delivery), `body`, `reply_to`, `thread_id`,
  `rid` (unique per sender), `hop`, optional `task_id`, `external_id` (the mirrored post on the chat app).
- **Delivery** (one per recipient): `unread` → `shown` (under a snapshot) → `acked`. `check_work` takes up to N
  non-acked deliveries, records a Snapshot of exactly those ids and returns its id; `ack(snapshot_id)` acks exactly those.
  Anything that arrives after the snapshot is not in it. Shown-but-unacked items come back on the next `check_work`, so an
  agent run that dies mid-way loses nothing.
- **Room messages are not broadcast.** A message in a room creates deliveries only for agents it @mentions (or the author
  of the message it answers). Other members can read the room history with `thread`, but are not woken.
- **Trust** is computed per delivery at send time: `owner` (from the human), `delegated` (the owner's trust rules allow
  this sender to give this recipient work), else `peer` (information only). `post_task` requires owner or delegated.
- **Hop**: owner messages are hop 0; a reply is parent hop + 1; a new message without `reply_to` inherits the maximum hop
  of the sender's latest snapshot + 1 (so "read something, then start a new thread about it" still counts). Above
  `MAX_HOPS` a send is refused with 409 `hop_limit`.
- **Tasks**: `claim_task` is one conditional update (submitted, or working with an expired lease, or already yours), so
  exactly one concurrent claimer wins. `report_task working` is a heartbeat that extends the lease.

## Add a channel in 5 steps

1. Create `src/channels/<name>.ts` exporting a `ChannelAdapter` (`src/core/plugins.ts`):
   - `parse(req, env)`: verify the platform's signature (return a 401 `Response` if it fails) and turn the webhook body into
     `InboundEvent[]` — room id, sender's user id, message id, text, and, when the user replied to a bot's post, that
     post's id and the bot's username. Skip messages sent by bots.
   - `post({room, agent, text, reply_to_external}, env)`: send as the agent's own identity on that platform
     (`agent.handles.<name>.token_env` names its secret), falling back to a hub identity; return the platform message id.
2. Register it in `src/channels/index.ts`. Its webhook is then `POST /channels/<name>/webhook`.
3. Add the owner's user id on that platform to `settingsFrom` in `src/build.ts` (`owners.<name>`), from an env var.
4. Give agents a handle for it (`handles: { <name>: { username, token_env } }`) and bind a room
   (`omb.mjs room <id> --channel <name> --chat <platform room id> --members …`).
5. Add a test like `test/telegram.test.ts`: parse fixtures, webhook auth, routing, outbound identity (mock fetch).

Notes for the planned ones:

| Channel | Inbound | Outbound per agent | Watch out for |
|---|---|---|---|
| Feishu / Lark | event subscription (`im.message.receive_v1`), verify token / encrypt key | one custom app (bot) per agent, `tenant_access_token` per app | tokens expire (2 h): cache per app; group bots need the "receive all group messages" permission |
| Discord | a gateway connection is needed for message events, which a Worker cannot hold; use interactions (slash commands) or a tiny gateway relay that POSTs to the hub | one application/bot per agent, or one bot with webhooks per channel (custom name + avatar per message) | message content intent is privileged |
| WeChat Work (企业微信) | app callback URL with AES message encryption | group robot webhooks post as a named robot; one robot per agent | robots can post but not read; reading needs a self-built app |

## Add a doorbell in 4 steps

1. Create `src/doorbells/<kind>.ts` exporting a `Doorbell`: `ring(cfg, payload, env)` returns `{ok, status?, detail?, busy?}`.
   `payload` carries the unread count, the latest id, the newest items with their bodies already wrapped as data, and a
   fixed instruction. Use `destination`/`bearer`/`post` from `common.ts` for https-only, no-redirect, timed-out POSTs.
   Return `busy: true` when the target says it is mid-run (it is retried after the coalesce window without counting as a
   failure). A doorbell that never calls out sets `passive: true`.
2. Register it in `src/doorbells/index.ts`.
3. If it needs a secret, read it with `env.secret(cfg.secret_env)` and document the `wrangler secret put` step. Never put a
   secret value in the doorbell config itself.
4. Add a test in `test/doorbell.test.ts` asserting the request it makes (URL, headers, body) with the mock fetch.

You never implement coalescing, backoff, logging or recovery in a doorbell: `core/ringer.ts` does that for all of them.

## Add a Store in 3 steps

1. Implement `Store` (`src/core/store.ts`). Honour the atomic methods: `insertMessage` (message + deliveries, unique
   `(from, rid)`), `saveSnapshot`, `claimTask`, `updateTask` (compare-and-set on state).
2. Construct the Hub with it (`buildHub(store, vars)`).
3. Add it to `stores` in `test/helpers.ts`; `test/core.test.ts` then runs the whole domain suite against it.

## Add an op in 2 steps

1. Add an entry to `OPS` in `src/ops/ops.ts`: name, description (agents read it), zod input, `readonly` if it changes
   nothing, and `run(hub, who, input)` calling a Hub method (put the rule in the Hub, not in the op).
2. It now exists on REST, in `/openapi.json` and as an MCP tool. Add a test.
