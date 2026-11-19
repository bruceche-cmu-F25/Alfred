import { useEffect, useMemo, useState } from "react";
import type { StateResponse } from "@alfred/protocol";
import { api } from "./api.ts";
import { desktop } from "./desktop.ts";
import { inboxItems, kindColour, kindName, KINDS, type InboxItem, type InboxKind } from "./shell/inbox.ts";
import { when } from "./shell/Nav.tsx";

export interface InboxProps {
  state: StateResponse;
  /** An item to bring up (e.g. from a notification): `p:<proposal id>`, `r:<run id>`, `n:<notice id>`. */
  focus: string | null;
  onFocused(): void;
  onOpenConversation(conversationId: string, runId?: string): void;
}

/** What one decision did, said back briefly. */
function outcomeText(state: string, error?: string): string {
  if (state === "executed") return "办好了。";
  if (state === "stale") return "这些东西在提议之后改过了，所以没有执行。";
  if (state === "expired") return "这个提议已经过期，没有执行。";
  if (state === "failed") return `没办成：${error ?? "出错了"}。已经回到原样。`;
  return "";
}

function Detail({ item, onDone, onOpenConversation, conversationTitle }: {
  item: InboxItem; onDone(message?: string): void; onOpenConversation(conversationId: string, runId?: string): void; conversationTitle?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revising, setRevising] = useState(false);
  const [text, setText] = useState("");
  useEffect(() => { setRevising(false); setText(""); setError(null); }, [item.id]);

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
          <button type="button" className="link" onClick={() => onOpenConversation(item.conversationId!, item.runId ?? undefined)}>来自对话「{conversationTitle}」</button>
        )}
        <span className="quiet">{when(item.at)}</span>
      </p>
      <h2>{item.title}</h2>
      {item.summary && <p className="inbox-summary">{item.summary}</p>}

      {proposal && (
        <>
          <div className="card">
            <p className="card-label">{proposal.stale ? "提议的事（已经过期）" : `接受后会做这 ${proposal.steps.length} 件事`}</p>
            <ol className="proposal-steps">{proposal.steps.map((step, n) => <li key={n}>{step.preview}</li>)}</ol>
          </div>
          {proposal.stale ? (
            <>
              <p className="problem small">这些东西在提议之后改过了，接受也不会执行。</p>
              <div className="inbox-actions">
                <button type="button" disabled={busy} onClick={() => act(() => api.revise(proposal.id, "情况变了，请按现在的情况重新看看，需要的话重新提议。").then(() => "已经让 Alfred 重新看看。"))}>让 Alfred 重新看看</button>
                <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.decline(proposal.id).then(() => undefined))}>不用了</button>
              </div>
            </>
          ) : revising ? (
            <form className="revise" onSubmit={(event) => { event.preventDefault(); if (text.trim()) act(() => api.revise(proposal.id, text.trim()).then(() => "已经交给 Alfred 改了，改好会再放到这里。")); }}>
              <textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} rows={2} maxLength={1000} placeholder="想怎么改？比如：只删第一条" aria-label="想怎么改" />
              <div className="inbox-actions">
                <button type="submit" disabled={busy || !text.trim()}>交给 Alfred 改</button>
                <button type="button" className="ghost" disabled={busy} onClick={() => setRevising(false)}>算了</button>
              </div>
            </form>
          ) : (
            <div className="inbox-actions">
              <button type="button" disabled={busy} onClick={() => act(() => api.accept(proposal.id).then(({ proposal: done }) => outcomeText(done.state, done.outcome?.error)))}>
                {proposal.steps.length > 1 ? `接受，做这 ${proposal.steps.length} 件` : "接受"}
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => setRevising(true)}>改一下</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.decline(proposal.id).then(() => undefined))}>不用了</button>
            </div>
          )}
          <p className="quiet small">{new Date(proposal.expiresAt).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}前有效。接受只会执行上面这些，不多做。</p>
        </>
      )}

      {run?.request && (
        <div className="inbox-actions">
          {run.request.kind === "permission" ? (
            <>
              <button type="button" disabled={busy} onClick={() => act(() => api.respond(run.id, run.request!.id, "allow").then(() => undefined))}>允许这一次</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.respond(run.id, run.request!.id, "deny").then(() => undefined))}>不允许</button>
            </>
          ) : run.request.options.map((option) => (
            <button type="button" key={option} disabled={busy} onClick={() => act(() => api.respond(run.id, run.request!.id, option).then(() => undefined))}>{option}</button>
          ))}
          <button type="button" className="ghost" onClick={() => onOpenConversation(run.conversationId, run.id)}>去对话里回答</button>
        </div>
      )}

      {notice?.kind === "run_interrupted" && (
        <div className="inbox-actions">
          <button type="button" disabled={busy} onClick={() => act(async () => { await api.resume(String(notice.payload.runId)); await api.acknowledge(notice.id); return "接着办了。"; })}>接着办</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.acknowledge(notice.id).then(() => undefined))}>不用了</button>
        </div>
      )}
      {(notice?.kind === "run_result" || notice?.kind === "welcome") && (
        <div className="inbox-actions">
          {item.conversationId && <button type="button" onClick={() => { void api.acknowledge(notice.id).catch(() => {}); onOpenConversation(item.conversationId!, item.runId ?? undefined); }}>打开对话</button>}
          <button type="button" className={item.conversationId ? "ghost" : undefined} disabled={busy} onClick={() => act(() => api.acknowledge(notice.id).then(() => undefined))}>知道了</button>
        </div>
      )}
      {error && <p className="problem small" role="alert">{error}</p>}
    </article>
  );
}

/** 通知: what needs you, and what Alfred wants you to know. A list on the left, the chosen item on the right. */
export function Inbox({ state, focus, onFocused, onOpenConversation }: InboxProps) {
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
  const chips = [["all", "全部", items.length] as const, ...KINDS.map(([kind, name]) => [kind, name, items.filter((item) => item.kind === kind).length] as const).filter(([, , count]) => count > 0)];

  return (
    <section className="inbox" aria-label="通知">
      {items.length > 0 && (
        <div className="chips" role="group" aria-label="按类别看">
          {chips.map(([id, name, count]) => (
            <button type="button" key={id} className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {id !== "all" && <span className="mark" data-k={kindColour(id)} />}{name}<span className="count">{count}</span>
            </button>
          ))}
        </div>
      )}
      {said && <p className="inbox-said" role="status">{said}</p>}
      {items.length === 0 ? (
        <div className="empty"><p className="empty-title">都处理完了</p><p className="quiet">今天不用再看这里。有事 Alfred 会放到这里。</p></div>
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
              <button type="button" className="back link" onClick={() => setSelected(null)}>← 全部通知</button>
              <Detail key={detail.id} item={detail} conversationTitle={titleOf(detail.conversationId) ?? undefined} onOpenConversation={onOpenConversation}
                onDone={(message) => { setSelected(null); if (message) setSaid(message); }} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
