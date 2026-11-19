import type { Notice } from "@alfred/protocol";
import type { FigureState } from "./entity/tesseract.js";
import { getLocale, translate, type Locale } from "./i18n/dict.ts";
import { plainText } from "./markdown.ts";

/** What Alfred says about a notice, how the figure looks while saying it, and what opening it means. */
export interface NoticeLines {
  title: string;
  body: string;
  /** The figure's state once it has finished speaking. */
  mood: FigureState;
  /** A question is closed by answering it and a proposal by deciding it, never just by opening them. */
  closesOnOpen: boolean;
  /** The label of the open button. */
  action: string;
}

/** In `locale` (default: the current one). Shared by the figure and the Mac app's fallback notifications. */
export function noticeLines(notice: Notice, locale: Locale = getLocale()): NoticeLines {
  const say = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
  const goal = String(notice.payload.goal ?? "");
  const look = say("presence.action.look");
  if (notice.kind === "run_interrupted") {
    return { title: say("mac.interrupted.title"), body: say("mac.interrupted.body", { goal }), mood: "error", closesOnOpen: true, action: look };
  }
  if (notice.kind === "proposal") {
    return { title: say("mac.proposal.title"), body: String(notice.payload.title ?? ""), mood: "notice", closesOnOpen: false, action: say("presence.action.decide") };
  }
  if (notice.kind === "run_request") {
    const permission = notice.payload.kind === "permission";
    return {
      title: say(permission ? "mac.permission.title" : "mac.input.title"), body: String(notice.payload.question ?? goal),
      mood: "notice", closesOnOpen: false, action: say(permission ? "presence.action.allow" : "presence.action.answer"),
    };
  }
  if (notice.kind === "outbound") {
    // An accepted change sent to Google (calendar, mail): whether it got there.
    const preview = String(notice.payload.preview ?? "");
    const state = notice.payload.state;
    if (state === "done") return { title: say("mac.outbound.done"), body: preview, mood: "done", closesOnOpen: true, action: look };
    if (state === "failed") {
      const error = notice.payload.error ? String(notice.payload.error) : "";
      return { title: say("mac.outbound.failed"), body: error ? say("mac.outbound.failedBody", { preview, error }) : preview, mood: "error", closesOnOpen: true, action: look };
    }
    return { title: say("mac.outbound.unknown"), body: say("mac.outbound.unknownBody", { preview }), mood: "notice", closesOnOpen: true, action: look };
  }
  const status = notice.payload.status;
  if (status === "failed") return { title: say("mac.failed.title"), body: say("mac.goal", { goal }), mood: "error", closesOnOpen: true, action: look };
  if (status === "cancelled") return { title: say("mac.cancelled.title"), body: say("mac.goal", { goal }), mood: "rest", closesOnOpen: true, action: look };
  return { title: goal ? say("mac.goal", { goal }) : "Alfred", body: (typeof notice.payload.reply === "string" && plainText(notice.payload.reply)) || say("mac.done.body", { goal }), mood: "done", closesOnOpen: true, action: look };
}
