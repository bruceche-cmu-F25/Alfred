import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ConversationDetail, CoreEvent, Run, RunRequest } from "@alfred/protocol";
import { api } from "./api.ts";
import { describeReceipt, ERRORS } from "./receipts.ts";

const WORKING: Partial<Record<Run["state"], string>> = {
  queued: "排队中", running: "在办", cancelling: "正在停下",
};

/** Steps of a run, one line per tool call, at its latest status. */
function steps(activity: CoreEvent[]): Array<{ id: string; label: string; about: string; status: string }> {
  const byStep = new Map<string, { id: string; label: string; about: string; status: string }>();
  for (const event of activity) {
    if (event.kind !== "run.step") continue;
    const id = String(event.payload.step);
    byStep.set(id, { id, label: String(event.payload.label ?? event.payload.tool), about: String(event.payload.about ?? ""), status: String(event.payload.status) });
  }
  return [...byStep.values()].filter((step) => step.label !== "Ask");
}

const STEP_MARK: Record<string, string> = { started: "…", done: "✓", failed: "✗", declined: "—" };

function Request({ run, request }: { run: Run; request: RunRequest }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const answer = (value: string) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    api.respond(run.id, request.id, value.trim()).catch((reason: Error) => { setError(reason.message); setBusy(false); });
  };
  const permission = request.kind === "permission";
  return (
    <div className="request" data-kind={request.kind} role="group" aria-label={permission ? "需要你允许" : "需要你回答"}>
      <p className="request-question">{request.question}</p>
      <div className="request-options">
        {permission ? (
          <>
            <button type="button" disabled={busy} onClick={() => answer("allow")}>允许这一次</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => answer("deny")}>不允许</button>
          </>
        ) : request.options.map((option) => (
          <button type="button" key={option} disabled={busy} onClick={() => answer(option)}>{option}</button>
        ))}
      </div>
      {!permission && (
        <form className="request-free" onSubmit={(event) => { event.preventDefault(); answer(text); }}>
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="或者直接回答…" aria-label="回答" maxLength={2000} disabled={busy} />
        </form>
      )}
      {error && <p className="problem small" role="alert">{error}</p>}
    </div>
  );
}

function Turn({ run, receipts, activity, live, highlighted }: { run: Run; receipts: CoreEvent[]; activity: CoreEvent[]; live?: string; highlighted: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action().catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const working = WORKING[run.state];
  const outcome = run.outcome;
  const runSteps = steps(activity);
  const answers = activity.filter((event) => event.kind === "run.answered");
  return (
    <li className="turn" data-highlighted={highlighted || undefined} id={`run-${run.id}`}>
      <p className="said">{run.goal}</p>
      <div className="reply" data-state={run.state}>
        {runSteps.length > 0 && (
          <ol className="steps" aria-label="办事过程">
            {runSteps.map((step) => (
              <li key={step.id} data-status={step.status}><span aria-hidden="true">{STEP_MARK[step.status] ?? "·"}</span> {step.label}{step.about ? `：${step.about}` : ""}</li>
            ))}
          </ol>
        )}
        {answers.map((event) => (
          <p className="answered small" key={event.id}>{String(event.payload.question)} → {event.payload.kind === "permission" ? (event.payload.answer === "allow" ? "已允许" : "没有允许") : String(event.payload.answer)}</p>
        ))}
        {run.request && <Request run={run} request={run.request} />}
        {working && !live && <p className="working"><span className="pulse" aria-hidden="true" />{working}…</p>}
        {live && !outcome && <p className="reply-text live">{live}</p>}
        {outcome?.reply && <p className="reply-text">{outcome.reply}</p>}
        {run.state === "failed" && <p className="problem">没办成。{ERRORS[outcome?.error ?? ""] ?? ""}</p>}
        {run.state === "cancelled" && <p className="quiet">已取消。</p>}
        {run.state === "interrupted" && <p className="problem">中断了：主节点在它办完之前停了。没有自动重做。</p>}
        {receipts.length > 0 && (
          <ul className="receipts" aria-label="实际做了的事">
            {receipts.map((event) => <li key={event.id}>{describeReceipt(event)}</li>)}
          </ul>
        )}
        {(run.state === "queued" || run.state === "running" || run.state === "interrupted" || run.request) && (
          <div className="turn-actions">
            {run.state === "interrupted" && <button type="button" disabled={busy} onClick={() => act(() => api.resume(run.id))}>继续</button>}
            <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.cancel(run.id))}>取消</button>
          </div>
        )}
        {error && <p className="problem small" role="alert">{error}</p>}
      </div>
    </li>
  );
}

export interface ConversationProps {
  /** null: a new conversation, started by the first message. */
  id: string | null;
  live: Readonly<Record<string, string>>;
  highlighted: ReadonlySet<string>;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  /** A run in this conversation opened a module view. */
  onView(module: string, view: string): void;
  onStarted(conversationId: string): void;
}

export function Conversation({ id, live, highlighted, onEvent, onView, onStarted }: ConversationProps) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setDetail(null);
    if (!id) return;
    let alive = true;
    const load = () => api.conversation(id).then((next) => { if (alive) setDetail(next); }).catch((reason: Error) => { if (alive) setError(reason.message); });
    void load();
    const off = onEvent((event) => {
      // Anything about this conversation or any run may concern it; reloading is cheap and local.
      if (event.subject !== `conversation:${id}` && !event.runId) return;
      if (event.kind === "run.view" && event.runId) {
        // Only views opened now, by a run here: not ones replayed from history.
        api.run(event.runId).then(({ run }) => { if (run.conversationId === id) onView(String(event.payload.module), String(event.payload.view)); }).catch(() => {});
      }
      if (timer.current === null) timer.current = window.setTimeout(() => { timer.current = null; void load(); }, 100);
    });
    return () => { alive = false; off(); };
  }, [id, onEvent, onView]);

  const runs = detail?.runs ?? [];
  const last = runs.at(-1);
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [last?.id, last?.state, last && live[last.id]?.length]);

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    const goal = draft.trim();
    if (!goal || sending) return;
    setSending(true);
    setError(null);
    api.submit(goal, id ?? undefined)
      .then(({ run }) => { setDraft(""); if (!id) onStarted(run.conversationId); })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setSending(false));
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter breaks the line; never while an IME is composing.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) send(event);
  };

  return (
    <section className="conversation" aria-label={detail?.conversation.title ?? "新对话"}>
      <header className="conversation-head">
        <h1>{id ? detail?.conversation.title ?? "…" : "新对话"}</h1>
      </header>
      {!id || runs.length === 0 ? (
        <div className="empty">
          <p className="empty-title">想让我做点什么？</p>
          <p className="quiet">比如「周五之前交报告」「把报告挪到下周一」「今天还剩什么」。</p>
        </div>
      ) : (
        <ol className="turns" ref={list}>
          {runs.map((run) => (
            <Turn key={run.id} run={run} receipts={detail?.receipts[run.id] ?? []} activity={detail?.activity[run.id] ?? []}
              live={live[run.id]} highlighted={highlighted.has(run.id)} />
          ))}
        </ol>
      )}
      <form className="composer" onSubmit={send}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
          rows={Math.min(6, Math.max(1, draft.split("\n").length))}
          placeholder={id ? "接着说…" : "跟 Alfred 说…"}
          aria-label="跟 Alfred 说"
          maxLength={8000}
        />
        <button type="submit" disabled={!draft.trim() || sending} aria-label="发送">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>
        </button>
      </form>
      {error && <p className="problem small composer-error" role="alert">{error}</p>}
    </section>
  );
}
