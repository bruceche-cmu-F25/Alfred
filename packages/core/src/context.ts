/** Who is acting, carried across awaits to the synchronous domain write. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ACTORS } from "./schema.ts";

export type Actor = (typeof ACTORS)[number];
export interface CoreContext {
  actor: Actor;
  /** Set only by the run executor. Domain writes under it are fenced by the run's lease. */
  run?: { id: string; owner: string };
}

const storage = new AsyncLocalStorage<CoreContext>();

export function withCoreContext<T>(context: CoreContext, action: () => T): T {
  return storage.run(context, action);
}

/** Background work is the system's unless a caller already said who is acting. */
export function withDefaultActor<T>(actor: Actor, action: () => T): T {
  return storage.getStore() ? action() : storage.run({ actor }, action);
}

/** Absent means unattributed: recorded as null, never guessed as the user. */
export function coreContext(): CoreContext | undefined {
  return storage.getStore();
}
