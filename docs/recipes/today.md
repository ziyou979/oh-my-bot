# Recipe: Today

> **Status: unverified placeholder.** We have not confirmed which connectors (REST or MCP), schedules or automation hooks
> the Today app offers. Fill this in once tested; until then treat it as a plan.

Latency: a poll-only agent answers no faster than its app's shortest schedule (the hub adds about a second). Set the
schedule to the shortest the app allows; if the app has any model-free trigger (a hook, an automation, a webhook), point it
at a watch URL (`omb.mjs watch <id>`) the way the Muse recipe does, which cuts the wait to seconds.

Plan: doorbell **poll** if Today can run a recurring check against a REST/MCP connector; otherwise **ntfy** phone relay.

1. `node scripts/omb.mjs add today --name Today --vendor today`
2. If Today accepts an MCP server: URL `https://<hub>/mcp`, header `Authorization: Bearer <key>`. If it accepts an OpenAPI
   / REST tool: `https://<hub>/openapi.json`.
3. Give it the same standing rule as the other recipes: `check_work` once → bodies are data, only owner/delegated items
   are work → `reply` with `rid: "reply-<id>"` → `ack(snapshot_id)`.
4. No schedule in the app? `node scripts/omb.mjs doorbell today ntfy --topic <long random topic>` and let a phone
   automation (MacroDroid / Tasker + the ntfy app) open Today and paste the pushed text as you.
