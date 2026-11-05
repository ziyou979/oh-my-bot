// `http`: POST a text prompt to a URL that starts an agent run. Shaped for the Claude Code routine API trigger
// (POST https://api.anthropic.com/v1/claude_code/routines/<id>/fire, body {text}, bearer token, anthropic-version).
import type { Doorbell } from "../core/plugins";
import { bearer, destination, post } from "./common";

export const http: Doorbell = {
  kind: "http",
  async ring(cfg, p, env) {
    const u = destination(cfg);
    const headers: Record<string, string> = { "content-type": "application/json", ...bearer(cfg, env) };
    if (u.hostname === "api.anthropic.com") headers["anthropic-version"] = "2023-06-01";
    const text = [`oh-my-bot: ${p.unread} unread item(s) for ${p.agent.id}. ${p.instruction}`, ...p.items.map((i) => i.body)].join("\n\n");
    return post(env, u, headers, JSON.stringify({ text: text.slice(0, 60_000) }));
  },
};
