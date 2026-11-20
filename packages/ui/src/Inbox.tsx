import { useEffect, useMemo, useRef, useState } from "react";
import type { StateResponse } from "@alfred/protocol";
import { api } from "./api.ts";
import { desktop } from "./desktop.ts";
import { Linked } from "./Linked.tsx";
import { FigureTour } from "./shell/Figure.tsx";
import type { PageLine } from "./shell/about.ts";
import { inboxItems, kindColour, kindName, KINDS, type InboxItem, type InboxKind } from "./shell/inbox.ts";
import { when } from "./shell/Nav.tsx";
import { intlLocale, t } from "./i18n/index.ts";

export interface InboxProps {
  state: StateResponse;
  /** An item to bring up (e.g. from a notification): `p:<proposal id>`, `r:<run id>`, `n:<notice id>`. */
  focus: string | null;
  onFocused(): void;
  onOpenConversation(conversationId: string, runId?: string): void;
  /** The bar under the page: what to change about a proposal is written there, as everywhere. */
  line: PageLine;
}

/** What one decision did, said back briefly. */
export function outcomeText(state: string, error?: string): string {
  if (state === "executed") return t("inbox.done");
  if (state === "stale") return t("inbox.out.stale");
  if (state === "expired") return t("inbox.out.expired");
  if (state === "failed") return t("inbox.out.failed", { error: error ?? t("inbox.out.error") });
  return "";
}

function Detail({ item, onDone, onOpenConversation, conversationTitle, line }: {
  item: InboxItem; onDone(message?: string): void; onOpenConversation(conversationId: string, runId?: string): void; conversationTitle?: string; line: PageLine;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [item.id]);
  // Another item, or none: the words in the bar were about the one before.
  const lineNow = useRef(line);
  lineNow.current = line;
  useEffect(() => () => { if (lineNow.current.about?.startsWith("inbox:")) lineNow.current.attach(null); }, [item.id]);

  const act = (action: () => Promise<string | undefined | void>) => {
    setBusy(true);
    setError(null);
    action().then((message) => onDone(message ?? undefined)).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const { proposal, run, notice } = item;

  return (
    <article className="inbox-detail" data-k={kindColour(item.kind)} aria-label={item.title}>
      <p className="inbox-kind"><span className="tag" data-k={kindColour(item.kind)}>{kindName(item.kind)}</span>
        {item.conversationId && conversationTitle && (
          <button type="button" className="link" onClick={() => onOpenConversation(item.conversationId!, item.runId ?? undefined)}>{t("inbox.from", { title: conversationTitle })}</button>
        )}
        <span className="quiet">{when(item.at)}</span>
      </p>
      <h2><Linked text={item.title} /></h2>
      {item.summary && <p className="inbox-summary"><Linked text={item.summary} /></p>}

      {proposal && (
        <>
          <div className="card">
            <p className="card-label">{proposal.stale ? t("inbox.stepsStale") : t("inbox.steps", { n: proposal.steps.length })}</p>
            <ol className="proposal-steps">{proposal.steps.map((step, n) => (
              <li key={n}><Linked text={step.preview} />{step.detail && <pre className="step-detail"><Linked text={step.detail} /></pre>}</li>
            ))}</ol>
          </div>
          {proposal.stale ? (
            <>
              <p className="problem small">{t("inbox.staleWarn")}</p>
              <div className="inbox-actions">
                <button type="button" disabled={busy} onClick={() => act(() => api.revise(proposal.id, t("inbox.lookAgainText")).then(() => t("inbox.lookingAgain")))}>{t("inbox.lookAgain")}</button>
                <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.decline(proposal.id).then(() => undefined))}>{t("common.no")}</button>
              </div>
            </>
          ) : (
            <div className="inbox-actions">
              <button type="button" disabled={busy} onClick={() => act(() => api.accept(proposal.id).then(({ proposal: done }) => outcomeText(done.state, done.outcome?.error)))}>
                {proposal.steps.length > 1 ? t("inbox.acceptN", { n: proposal.steps.length }) : t("inbox.accept")}
              </button>
              {/* What to change is said in the bar under the page; the new version then lands in this list. */}
              <button type="button" className="ghost" disabled={busy} aria-pressed={line.about === `inbox:change:${proposal.id}`} onClick={() => line.attach(line.about === `inbox:change:${proposal.id}` ? null : {
                key: `inbox:change:${proposal.id}`, label: t("inbox.revise"), placeholder: t("inbox.revisePlaceholder"),
                send: async (words) => { await line.revise(proposal.id, words, { id: proposal.id, title: proposal.title.slice(0, 200) }); onDone(t("inbox.revised")); },
              })}>{t("inbox.revise")}</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.decline(proposal.id).then(() => undefined))}>{t("common.no")}</button>
            </div>
          )}
          <p className="quiet small">{t("inbox.expires", { date: new Date(proposal.expiresAt).toLocaleDateString(intlLocale(), { month: "long", day: "numeric" }) })}</p>
        </>
      )}

      {run?.request && (
        <div className="inbox-actions">
          {run.request.kind === "permission" ? (
            <>
              <button type="button" disabled={busy} onClick={() => act(() => api.respond(run.id, run.request!.id, "allow").then(() => undefined))}>{t("common.allow")}</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.respond(run.id, run.request!.id, "deny").then(() => undefined))}>{t("common.deny")}</button>
            </>
          ) : run.request.options.map((option) => (
            <button type="button" key={option} disabled={busy} onClick={() => act(() => api.respond(run.id, run.request!.id, option).then(() => undefined))}>{option}</button>
          ))}
          <button type="button" className="ghost" onClick={() => onOpenConversation(run.conversationId, run.id)}>{t("inbox.answerInConversation")}</button>
        </div>
      )}

      {notice?.kind === "run_interrupted" && (
        <div className="inbox-actions">
          <button type="button" disabled={busy} onClick={() => act(async () => { await api.resume(String(notice.payload.runId)); await api.acknowledge(notice.id); return t("inbox.resumed"); })}>{t("inbox.resume")}</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.acknowledge(notice.id).then(() => undefined))}>{t("common.no")}</button>
        </div>
      )}
      {(notice?.kind === "run_result" || notice?.kind === "welcome") && (
        <div className="inbox-actions">
          {item.conversationId && <button type="button" onClick={() => { void api.acknowledge(notice.id).catch(() => {}); onOpenConversation(item.conversationId!, item.runId ?? undefined); }}>{t("inbox.openConversation")}</button>}
          <button type="button" className={item.conversationId ? "ghost" : undefined} disabled={busy} onClick={() => act(() => api.acknowledge(notice.id).then(() => undefined))}>{t("common.gotIt")}</button>
        </div>
      )}
      {error && <p className="problem small" role="alert">{error}</p>}
    </article>
  );
}

/** 通知: what needs you, and what Alfred wants you to know. A list on the left, the chosen item on the right. */
export function Inbox({ state, focus, onFocused, onOpenConversation, line }: InboxProps) {
  const items = useMemo(() => inboxItems(state, desktop?.userName ?? null), [state]);
  const [filter, setFilter] = useState<InboxKind | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    if (!focus) return;
    if (items.some((item) => item.id === focus)) { setFilter("all"); setSelected(focus); }
    onFocused();
  }, [focus, items, onFocused]);
  useEffect(() => { if (!said) return; const timer = window.setTimeout(() => setSaid(null), 5000); return () => window.clearTimeout(timer); }, [said]);

  const shown = items.filter((item) => filter === "all" || item.kind === filter);
  // Keep a selection on a wide screen: the chosen item, else the first one.
  const current = shown.find((item) => item.id === selected) ?? null;
  const detail = current ?? (window.matchMedia("(min-width: 701px)").matches ? shown[0] ?? null : null);
  const titleOf = (id: string | null) => state.conversations.find((conversation) => conversation.id === id)?.title;
  const chips = [["all", t("common.all"), items.length] as const, ...KINDS.map(([kind, name]) => [kind, t(name), items.filter((item) => item.kind === kind).length] as const).filter(([, , count]) => count > 0)];

  return (
    <section className="inbox" aria-label={t("inbox.label")}>
      {items.length > 0 && (
        <div className="chips" role="group" aria-label={t("inbox.byKind")}>
          {chips.map(([id, name, count]) => (
            <button type="button" key={id} className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {id !== "all" && <span className="mark" data-k={kindColour(id)} />}{name}<span className="count">{count}</span>
            </button>
          ))}
        </div>
      )}
      {said && <p className="inbox-said" role="status">{said}</p>}
      {items.length === 0 ? (
        <div className="empty"><FigureTour size={112} /><p className="empty-title">{t("inbox.emptyTitle")}</p><p className="quiet">{t("inbox.emptyHint")}</p></div>
      ) : (
        <div className="split" data-open={current ? "" : undefined}>
          <ul className="inbox-list">
            {shown.map((item) => (
              <li key={item.id}>
                <button type="button" className="note" aria-current={detail?.id === item.id ? "true" : undefined} onClick={() => setSelected(item.id)}>
                  <span className="mark" data-k={kindColour(item.kind)} aria-label={kindName(item.kind)} />
                  <span className="note-body"><b>{item.title}</b><span>{item.summary}</span></span>
                  <time>{when(item.at)}</time>
                </button>
              </li>
            ))}
          </ul>
          {detail && (
            <div className="inbox-pane">
              <button type="button" className="back link" onClick={() => setSelected(null)}>{t("inbox.back")}</button>
              <Detail key={detail.id} item={detail} conversationTitle={titleOf(detail.conversationId) ?? undefined} onOpenConversation={onOpenConversation} line={line}
                onDone={(message) => { setSelected(null); if (message) setSaid(message); }} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
