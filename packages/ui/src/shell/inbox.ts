/** The inbox (the 通知 page): one list of what needs the user or what Alfred wants them to know, read from the
 * core's state. It stores nothing of its own: an item leaves when its proposal is decided, its run moves on, or its
 * notice is acknowledged.
 *   decide  a proposal; a run waiting on an answer or a permission; a run that was interrupted
 *   result  a run finished (not yet seen)
 *   away    what happened while the user was away
 */
import type { AwayDigest, Notice, Proposal, Run, StateResponse } from "@alfred/protocol";
import { t, type Key } from "../i18n/index.ts";
import { welcomeLines } from "../welcome.ts";

export type InboxKind = "decide" | "result" | "away" | "remind";
export const KINDS: Array<[InboxKind, Key, string]> = [["decide", "inbox.k.decide", "warm"], ["result", "inbox.k.result", "alfred"], ["away", "inbox.k.away", "gray"], ["remind", "inbox.k.remind", "teal"]];
export const kindName = (kind: InboxKind) => t(KINDS.find(([id]) => id === kind)![1]);
export const kindColour = (kind: InboxKind) => KINDS.find(([id]) => id === kind)![2];

export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  summary: string;
  at: string;
  conversationId: string | null;
  runId: string | null;
  proposal?: Proposal;
  run?: Run;
  notice?: Notice;
}

export function inboxItems(state: StateResponse, userName: string | null = null): InboxItem[] {
  const items: InboxItem[] = [];
  for (const proposal of state.proposals ?? []) {
    items.push({ id: `p:${proposal.id}`, kind: "decide", title: proposal.title, summary: proposal.summary, at: proposal.createdAt,
      conversationId: proposal.conversationId, runId: proposal.runId, proposal });
  }
  for (const run of state.runs) {
    if (!run.request) continue;
    items.push({ id: `r:${run.id}`, kind: "decide", title: run.request.question,
      summary: t(run.request.kind === "permission" ? "inbox.r.permission" : "inbox.r.input", { goal: run.goal }), at: run.request.createdAt,
      conversationId: run.conversationId, runId: run.id, run });
  }
  for (const notice of state.notices) {
    const goal = String(notice.payload.goal ?? "");
    const conversationId = (notice.payload.conversationId as string | undefined) ?? null, runId = (notice.payload.runId as string | undefined) ?? null;
    if (notice.kind === "run_interrupted") {
      items.push({ id: `n:${notice.id}`, kind: "decide", title: t("inbox.interrupted.title", { goal }), summary: t("inbox.interrupted.summary"),
        at: notice.createdAt, conversationId, runId, notice });
    } else if (notice.kind === "run_result") {
      // A run that left a proposal is said by the proposal itself.
      if (runId && (state.proposals ?? []).some((proposal) => proposal.runId === runId)) continue;
      const status = notice.payload.status;
      const summary = status === "failed" ? t("inbox.failed") : status === "cancelled" ? t("inbox.cancelled") : String(notice.payload.reply ?? t("inbox.done"));
      items.push({ id: `n:${notice.id}`, kind: "result", title: goal, summary, at: notice.createdAt, conversationId, runId, notice });
    } else if (notice.kind === "welcome") {
      const { greeting, summary } = welcomeLines(notice.payload as unknown as AwayDigest, userName);
      items.push({ id: `n:${notice.id}`, kind: "away", title: greeting, summary, at: notice.createdAt, conversationId: null, runId: null, notice });
    }
  }
  // What needs a decision first; within each, newest first.
  return items.sort((a, b) => Number(b.kind === "decide") - Number(a.kind === "decide") || b.at.localeCompare(a.at));
}

/** What still needs a decision: the sidebar's number and the figure's amber. Stale proposals only need dismissing. */
export const waitingCount = (state: StateResponse) =>
  (state.proposals ?? []).filter((proposal) => !proposal.stale).length + state.runs.filter((run) => run.request).length;
