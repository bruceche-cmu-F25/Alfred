/** The home node's side of attention (docs/design/attention.md): it asks the table (core attention.ts) about every
 * notice nobody holds, and hands each to the outlet the table names, when the table says.
 *
 * So far it hands only to outlets it can reach without a device's help: the phones' push notifications. The Mac's
 * figure and the app's windows still take notices for themselves (until the design's steps A3 and A4); what they
 * take is no longer pending, so it never comes up here.
 */
import { ATTENTION, claimNotice, decide, pendingNotices, type AttentionPolicy, type Notice, type Outlet, type World } from "@alfred/core";

/** An outlet the home node can tell the user through by itself. */
export interface Reach {
  outlet: Outlet;
  /** Tells the user there. True when it went out, which is not proof they saw it. */
  send(notice: Notice): Promise<boolean>;
  /** How long the notice stays this outlet's once it went out, before another may show it after all. */
  holdMs: number;
}

export interface AttentionOptions {
  world: World;
  /** The outlets there are to hand to right now. None: nothing is looked at until there is one. */
  reaches(): Reach[];
  policy?: AttentionPolicy;
  log?: (message: string) => void;
}

/** Follows the world: every notice nobody took is put to the table, now and again when the table says to wait. */
export function watchAttention(options: AttentionOptions): { close(): void } {
  const { world } = options;
  const policy = options.policy ?? ATTENTION;
  /** Notices that need no more thought for now: handed on, on their way, or waiting for the user's return. */
  const settled = new Set<string>();
  /** Per notice, the outlets it was handed to that did not take it. */
  const tried = new Map<string, Set<string>>();
  let closed = false;
  let wake: NodeJS.Timeout | null = null;
  let wakeAt = Infinity;

  const again = (at: number) => {
    if (at === Infinity || (wake && wakeAt <= at)) return;
    if (wake) clearTimeout(wake);
    wakeAt = at;
    wake = setTimeout(() => { wake = null; wakeAt = Infinity; look(); }, Math.max(0, at - Date.now()));
  };

  const hand = async (notice: Notice, reach: Reach) => {
    try {
      if (await reach.send(notice)) {
        // It is that outlet's now, so no other shows it again later. A device may have taken it meanwhile.
        if (!closed) try { claimNotice(world, notice.id, reach.outlet.id, { ttlMs: reach.holdMs }); } catch { /* taken */ }
        return;
      }
    } catch (error) {
      options.log?.(`telling ${reach.outlet.id} about notice ${notice.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (closed) return;
    // It did not go out there: that outlet is passed over, and the table is asked once more.
    tried.set(notice.id, new Set([...(tried.get(notice.id) ?? []), reach.outlet.id]));
    settled.delete(notice.id);
    look();
  };

  /** Reads only, so it can run after every commit without causing one. */
  function look(): void {
    if (closed) return;
    const reaches = options.reaches();
    if (!reaches.length) return;
    const pending = pendingNotices(world);
    const ids = new Set(pending.map((notice) => notice.id));
    for (const id of settled) if (!ids.has(id)) settled.delete(id);
    for (const id of tried.keys()) if (!ids.has(id)) tried.delete(id);
    const now = Date.now();
    let next = Infinity;
    for (const notice of pending) {
      if (settled.has(notice.id)) continue;
      const decision = decide(notice, reaches.map((reach) => reach.outlet), now, { tried: tried.get(notice.id), policy });
      if (decision.do === "wait" && decision.until !== "return") { next = Math.min(next, decision.until); continue; }
      settled.add(notice.id);
      const reach = decision.do === "tell" ? reaches.find((candidate) => candidate.outlet.id === decision.outlet) : undefined;
      if (reach) void hand(notice, reach);
    }
    again(next);
  }

  const unsubscribe = world.onCommit(() => setImmediate(look));
  look();
  return {
    close() {
      closed = true;
      unsubscribe();
      if (wake) clearTimeout(wake);
    },
  };
}
