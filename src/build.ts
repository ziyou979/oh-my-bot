// Builds a Hub from string settings (Worker env or process.env). Shared by the Worker and the Node server.
import { CHANNELS } from "./channels";
import { DEFAULTS, Hub, type HubSettings } from "./core/hub";
import type { HubEnv } from "./core/plugins";
import type { Store } from "./core/store";
import { DOORBELLS } from "./doorbells";

export type Vars = Record<string, unknown>;

const num = (v: unknown, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function settingsFrom(vars: Vars): HubSettings {
  return {
    ...DEFAULTS,
    maxHops: num(vars.MAX_HOPS, DEFAULTS.maxHops),
    pairLimitPerMin: num(vars.PAIR_LIMIT_PER_MIN, DEFAULTS.pairLimitPerMin),
    coalesceMs: num(vars.COALESCE_SECONDS, DEFAULTS.coalesceMs / 1000) * 1000,
    leaseMs: num(vars.TASK_LEASE_SECONDS, DEFAULTS.leaseMs / 1000) * 1000,
    owners: vars.OWNER_TELEGRAM_ID ? { telegram: String(vars.OWNER_TELEGRAM_ID) } : {},
    notice: typeof vars.SERVER_NOTICE === "string" && vars.SERVER_NOTICE ? vars.SERVER_NOTICE : undefined,
  };
}

export function buildHub(store: Store, vars: Vars, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Hub {
  const env: HubEnv = {
    // ADMIN_KEY is never handed to a plugin, whatever a doorbell config names.
    secret: (n) => (n !== "ADMIN_KEY" && typeof vars[n] === "string" && vars[n] ? (vars[n] as string) : undefined),
    fetch: (input, init) => fetchImpl(input, init), // unbound: Workers' fetch must not be called as a method
    now,
  };
  return new Hub(store, env, DOORBELLS, CHANNELS, settingsFrom(vars));
}
