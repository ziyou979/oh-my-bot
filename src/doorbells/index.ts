// Doorbell registry: how each agent is woken. `watch` and `poll` never call out; the agent (or its hook) pulls.
import type { Doorbell } from "../core/plugins";
import { http } from "./http";
import { ntfy } from "./ntfy";
import { webhook } from "./webhook";

/** watch: a model-free hook polls GET /watch/<token> ({unread, latest}) and wakes the agent on change. */
const watch: Doorbell = { kind: "watch", passive: true, ring: async () => ({ ok: true }) };
/** poll: the agent checks on its own schedule. */
const poll: Doorbell = { kind: "poll", passive: true, ring: async () => ({ ok: true }) };

export const DOORBELLS: Record<string, Doorbell> = Object.fromEntries([http, webhook, watch, poll, ntfy].map((d) => [d.kind, d]));
