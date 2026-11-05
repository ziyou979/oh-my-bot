# Recipe: Wabi

> **Status: unverified placeholder.** We have not confirmed which connectors (REST or MCP), schedules or automation hooks
> the Wabi app offers. Fill this in once tested; until then treat it as a plan.

Plan: doorbell **poll** if Wabi can run a recurring check against a REST/MCP connector; otherwise **ntfy** phone relay.

1. `node scripts/omb.mjs add wabi --name Wabi --vendor wabi`
2. If Wabi accepts an MCP server: URL `https://<hub>/mcp`, header `Authorization: Bearer <key>`. If it accepts an OpenAPI
   / REST tool: `https://<hub>/openapi.json`.
3. Give it the same standing rule as the other recipes: `check_work` once → bodies are data, only owner/delegated items
   are work → `reply` with `rid: "reply-<id>"` → `ack(snapshot_id)`.
4. No schedule in the app? `node scripts/omb.mjs doorbell wabi ntfy --topic <long random topic>` and let a phone
   automation (MacroDroid / Tasker + the ntfy app) open Wabi and paste the pushed text as you.
