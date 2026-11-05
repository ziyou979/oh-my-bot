// `ntfy`: push to the owner's phone through an ntfy topic; an automation app there (MacroDroid, Tasker) opens the
// agent's app and pastes the text as the owner's own message. Because that text arrives as the OWNER speaking, only
// owner-trust bodies are relayed in full; everything else is reduced to a count the agent must fetch itself.
import type { Doorbell } from "../core/plugins";
import { bearer, post } from "./common";

export const ntfy: Doorbell = {
  kind: "ntfy",
  async ring(cfg, p, env) {
    if (!cfg.topic) throw new Error("ntfy doorbell needs a topic");
    const server = (cfg.server ?? "https://ntfy.sh").replace(/\/$/, "");
    const owner = p.items.filter((i) => i.trust === "owner");
    const others = p.unread - owner.length;
    const text = [p.instruction, ...owner.map((i) => i.body), others > 0 ? `(${others} other item(s): read them with check_work)` : ""]
      .filter(Boolean).join("\n\n");
    return post(env, `${server}/${encodeURIComponent(cfg.topic)}`, { title: `oh-my-bot: ${p.agent.name}`, ...bearer(cfg, env) }, text.slice(0, 3500));
  },
};
