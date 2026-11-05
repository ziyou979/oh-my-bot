// `webhook`: POST a JSON event (Grok Bot routine webhook trigger and similar). HTTP 400/409/429 from a runner that is
// mid-run means busy: the ring is retried after the coalesce window without counting as a failure.
import type { Doorbell } from "../core/plugins";
import { bearer, destination, post } from "./common";

export const webhook: Doorbell = {
  kind: "webhook",
  async ring(cfg, p, env) {
    const body = { source: "oh-my-bot", agent: p.agent.id, unread: p.unread, latest: p.latest, items: p.items, instruction: p.instruction };
    const r = await post(env, destination(cfg), { "content-type": "application/json", ...bearer(cfg, env) }, JSON.stringify(body));
    return r.ok || ![400, 409, 429].includes(r.status ?? 0) ? r : { ...r, busy: true };
  },
};
