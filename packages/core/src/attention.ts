/** Attention: by whom, where and when the user is told about a notice (docs/design/attention.md).
 *
 * It is one decision, and this file is where it is made: what kind of thing a notice is to the user, the table that
 * says which outlet it goes to, and the waiting times in between. `decide` is pure, so the whole table can be read
 * and tested here.
 *
 * Not everything follows it yet. Push does (server push.ts). The Mac's figure and the app's windows still decide
 * for themselves, by rules of their own that this table was written from; they come under it in the design's steps
 * A3 and A4.
 */

/** What a notice is to the user. */
export const NOTICE_CLASSES = ["needs_you", "tells_you", "greeting"] as const;
/** `needs_you`: it waits on the user (a question, a proposal, an interrupted run, a change outside that failed or
 * may not have happened). `tells_you`: something they will want to know, and nothing to do. `greeting`: the welcome
 * when they come back. */
export type NoticeClass = (typeof NOTICE_CLASSES)[number];

/** The class of a notice, from its kind and what it carries. This is the one list of which notices matter how: a
 * notice kind added later gets its place here. Until it has one it tells, and is not pushed. */
export function noticeClass(kind: string, payload: Record<string, unknown>): NoticeClass {
  if (kind === "welcome") return "greeting";
  if (kind === "run_request" || kind === "proposal" || kind === "run_interrupted") return "needs_you";
  // A change outside Alfred that went through is news; one that was refused or may not have happened needs a look.
  if (kind === "outbound") return payload.state === "done" ? "tells_you" : "needs_you";
  return "tells_you";
}

/** A place on a device that can tell the user something, as it last described itself. */
export interface Outlet {
  /** Unique among outlets: the device it is on and what it is. */
  id: string;
  /** A window of the app; the Mac's always-there figure; or a phone's push notifications. */
  kind: "window" | "figure" | "push";
  /** A window: on screen and in use. A figure: the user is at its machine. Push: never, it reaches a pocket. */
  attending: boolean;
  /** For a window: when the user last did something in it. Among several in use, the latest gets the notice. */
  activeAt?: number;
}

/** What to do about a notice now. */
export type Decision =
  /** Hand it to this outlet. */
  | { do: "tell"; outlet: string }
  /** Nobody to tell yet: decide again at this time, or when the user comes back. */
  | { do: "wait"; until: number | "return" }
  /** Not this decision's: a greeting is handed, when it is made, to the device that saw the user come back. */
  | { do: "nothing" };

export interface AttentionPolicy {
  /** The figure speaks only once a notice is this old: a window in use shows it first, in place. */
  figureAfterMs: number;
  /** A notice nobody took goes to the phone once it is this old. */
  pushAfterMs: number;
  /** A notice older than this is not pushed any more (the home node was off, or it was found late): it is no
   * longer news worth a buzz, and waits for the user's return. */
  pushWhileFreshMs: number;
  /** Whether a notice of this kind and class goes to the phone at all when the user is at no device. */
  pushes(notice: { kind: string; class: NoticeClass }): boolean;
}

export const ATTENTION: AttentionPolicy = {
  figureAfterMs: 1500,
  pushAfterMs: 20_000,
  pushWhileFreshMs: 10 * 60_000,
  // What needs the user reaches them wherever they are. Of the news, a run's result does (they asked, and left);
  // "it went through" for a change they have just said yes to does not.
  pushes: (notice) => notice.class === "needs_you" || notice.kind === "run_result",
};

/**
 * The table, top row first:
 *
 *   a window in use            → that window, at once (the one used last)
 *   at the Mac, not looking    → the Mac's figure, once the notice is `figureAfterMs` old
 *   at no device               → the phone, once it is `pushAfterMs` old, if this kind is pushed and still fresh
 *   otherwise                  → wait for the user's return
 *
 * `tried`: outlets that were handed this notice and did not present it; they are passed over.
 */
export function decide(
  notice: { kind: string; class: NoticeClass; createdAt: string },
  outlets: readonly Outlet[],
  now: number,
  options: { tried?: ReadonlySet<string>; policy?: AttentionPolicy } = {},
): Decision {
  const policy = options.policy ?? ATTENTION;
  if (notice.class === "greeting") return { do: "nothing" };
  const open = outlets.filter((outlet) => !options.tried?.has(outlet.id));
  const age = now - Date.parse(notice.createdAt);

  const windows = open.filter((outlet) => outlet.kind === "window" && outlet.attending).sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
  if (windows.length) return { do: "tell", outlet: windows[0].id };

  const figure = open.find((outlet) => outlet.kind === "figure" && outlet.attending);
  if (figure) return age >= policy.figureAfterMs ? { do: "tell", outlet: figure.id } : { do: "wait", until: now + policy.figureAfterMs - age };

  const push = open.find((outlet) => outlet.kind === "push");
  if (push && policy.pushes(notice) && age <= policy.pushWhileFreshMs) {
    return age >= policy.pushAfterMs ? { do: "tell", outlet: push.id } : { do: "wait", until: now + policy.pushAfterMs - age };
  }
  return { do: "wait", until: "return" };
}
