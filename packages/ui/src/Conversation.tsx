import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ConversationDetail, CoreEvent, EngineModel, Run, RunRequest, ThinkingLevel, ViewContext } from "@alfred/protocol";
import { ApiError, api } from "./api.ts";
import { t, type Key } from "./i18n/index.ts";
import { describeReceipt, errorText } from "./receipts.ts";

const WORKING: Partial<Record<Run["state"], Key>> = {
  queued: "run.queued", running: "run.running", cancelling: "run.cancelling",
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
    <div className="request" data-kind={request.kind} role="group" aria-label={t(permission ? "req.permission" : "req.input")}>
      <p className="request-question">{request.question}</p>
      <div className="request-options">
        {permission ? (
          <>
            <button type="button" disabled={busy} onClick={() => answer("allow")}>{t("common.allow")}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => answer("deny")}>{t("common.deny")}</button>
          </>
        ) : request.options.map((option) => (
          <button type="button" key={option} disabled={busy} onClick={() => answer(option)}>{option}</button>
        ))}
      </div>
      {!permission && (
        <form className="request-free" onSubmit={(event) => { event.preventDefault(); answer(text); }}>
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder={t("req.free")} aria-label={t("req.answer")} maxLength={2000} disabled={busy} />
        </form>
      )}
      {error && <p className="problem small" role="alert">{error}</p>}
    </div>
  );
}

function Turn({ run, receipts, activity, live, highlighted, askedOn, startedBy }: { run: Run; receipts: CoreEvent[]; activity: CoreEvent[]; live?: string; highlighted: boolean; askedOn?: string; startedBy?: string }) {
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
  const added = activity.filter((event) => event.kind === "run.steered");
  const usage = activity.filter((event) => event.kind === "run.usage").at(-1);
  return (
    <li className="turn" data-highlighted={highlighted || undefined} id={`run-${run.id}`}>
      {askedOn && <p className="asked-on">{t("conv.askedFrom", { page: askedOn })}</p>}
      {/* An automation's run: nobody said anything; say which automation started it, and when. */}
      {startedBy ? <p className="asked-on auto-from" title={run.goal}>{startedBy}</p> : <p className="said">{run.goal}</p>}
      {added.map((event) => <p className="said added" key={event.id}>{String(event.payload.text)}</p>)}
      <div className="reply" data-state={run.state}>
        {runSteps.length > 0 && (
          <ol className="steps" aria-label={t("run.steps")}>
            {runSteps.map((step) => (
              <li key={step.id} data-status={step.status}><span aria-hidden="true">{STEP_MARK[step.status] ?? "·"}</span> {step.label}{step.about ? `：${step.about}` : ""}</li>
            ))}
          </ol>
        )}
        {answers.map((event) => (
          <p className="answered small" key={event.id}>{String(event.payload.question)} → {event.payload.kind === "permission" ? t(event.payload.answer === "allow" ? "run.allowed" : "run.denied") : String(event.payload.answer)}</p>
        ))}
        {run.request && <Request run={run} request={run.request} />}
        {working && !live && <p className="working"><span className="pulse" aria-hidden="true" />{t(working)}…</p>}
        {live && !outcome && <p className="reply-text live">{live}</p>}
        {outcome?.reply && <p className="reply-text">{outcome.reply}</p>}
        {run.state === "failed" && <p className="problem">{t("run.failed")} {errorText(outcome?.error)}</p>}
        {run.state === "cancelled" && <p className="quiet">{t("run.cancelled")}</p>}
        {run.state === "interrupted" && <p className="problem">{t("run.interrupted")}</p>}
        {receipts.length > 0 && (
          <ul className="receipts" aria-label={t("run.receipts")}>
            {receipts.map((event) => <li key={event.id}>{describeReceipt(event)}</li>)}
          </ul>
        )}
        {(run.state === "queued" || run.state === "running" || run.state === "interrupted" || run.request) && (
          <div className="turn-actions">
            {run.state === "interrupted" && <button type="button" disabled={busy} onClick={() => act(() => api.resume(run.id))}>{t("common.continue")}</button>}
            <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.cancel(run.id))}>{t("common.cancel")}</button>
          </div>
        )}
        {usage?.payload.model ? <p className="run-meta">{String(usage.payload.model)}</p> : null}
        {error && <p className="problem small" role="alert">{error}</p>}
      </div>
    </li>
  );
}

const THINKING: Array<[ThinkingLevel | "", Key]> = [["", "think.default"], ["off", "think.off"], ["low", "think.low"], ["medium", "think.medium"], ["high", "think.high"]];
let modelList: Promise<EngineModel[]> | null = null;

/** The conversation's model and thinking level, and how full its context is. Unset means Pi's defaults. */
function Settings({ detail }: { detail: ConversationDetail }) {
  const [models, setModels] = useState<EngineModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    modelList ??= api.models().then((response) => response.models).catch(() => { modelList = null; return []; });
    void modelList.then(setModels);
  }, []);
  const { conversation } = detail;
  const change = (patch: { model?: string | null; thinking?: ThinkingLevel | null }) => {
    setError(null);
    api.updateConversation(conversation.id, patch).catch((reason: Error) => setError(reason.message));
  };
  const usage = Object.values(detail.activity).flat().filter((event) => event.kind === "run.usage").sort((a, b) => a.seq - b.seq).at(-1);
  const percent = typeof usage?.payload.percent === "number" ? Math.round(usage.payload.percent) : null;
  const known = new Set(models.map((model) => `${model.provider}/${model.id}`));
  return (
    <div className="conversation-settings">
      <select aria-label={t("conv.model")} value={conversation.model ?? ""} onChange={(event) => change({ model: event.target.value || null })}>
        <option value="">{t("conv.defaultModel")}</option>
        {conversation.model && !known.has(conversation.model) && <option value={conversation.model}>{conversation.model}</option>}
        {models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}
      </select>
      <select aria-label={t("conv.thinking")} value={conversation.thinking ?? ""} onChange={(event) => change({ thinking: (event.target.value || null) as ThinkingLevel | null })}>
        {THINKING.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
      </select>
      {percent !== null && <span className="context-usage" title={`${String(usage?.payload.tokens ?? "")} tokens`}>{t("conv.context", { n: percent })}</span>}
      {error && <span className="problem small">{error}</span>}
    </div>
  );
}

export interface ConversationProps {
  /** null: a new conversation, started by the first message. */
  id: string | null;
  live: Readonly<Record<string, string>>;
  highlighted: ReadonlySet<string>;
  /** The page a message sent now is asked from; nothing when no page is in view. */
  context?: ViewContext;
  /** Questions to offer, from that page. */
  suggestions: string[];
  /** A page's title by its key, in the current language; for pages this device no longer has, the title saved with the run. */
  pageTitle(view: string): string | undefined;
  /** An automation's name by its id, for runs it started; nothing once it is deleted. */
  automationTitle(id: string): string | undefined;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  /** A run in this conversation opened a module view. */
  onView(module: string, view: string): void;
  onStarted(conversationId: string): void;
}

export function Conversation({ id, live, highlighted, context, suggestions, pageTitle, automationTitle, onEvent, onView, onStarted }: ConversationProps) {
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

  // While a run works, what you say joins it, as in Claude; otherwise it is the next request.
  const working = last?.state === "running" ? last : null;
  const send = (event?: FormEvent, text = draft) => {
    event?.preventDefault();
    const goal = text.trim();
    if (!goal || sending) return;
    setSending(true);
    setError(null);
    const submit = () => api.submit(goal, id ?? undefined, context).then(({ run }) => { if (!id) onStarted(run.conversationId); });
    const attempt = working
      // It may have just finished: then it goes as a new message.
      ? api.steer(working.id, goal).then(() => undefined, (reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 409) return submit();
        throw reason;
      })
      : submit();
    attempt
      .then(() => { if (text === draft) setDraft(""); })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setSending(false));
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter breaks the line; never while an IME is composing.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) send(event);
  };

  // Which page a question came from, said once each time it changes, not on every turn.
  const startedBy = (run: Run) => run.automationId
    ? t("auto.fromAt", { name: automationTitle(run.automationId) ?? t("auto.removed"), at: new Date(run.createdAt).toTimeString().slice(0, 5) })
    : undefined;
  const askedOn = (run: Run, previous: Run | undefined) =>
    run.context && run.context.view !== previous?.context?.view ? pageTitle(run.context.view) ?? run.context.title ?? run.context.view : undefined;
  const offer = !draft.trim() && !working && !sending && suggestions.length > 0;

  return (
    <section className="conversation" aria-label={detail?.conversation.title ?? t("conv.new")}>
      <header className="conversation-head">
        <h1>{id ? detail?.conversation.title ?? "…" : t("conv.new")}</h1>
        {detail && <Settings detail={detail} />}
      </header>
      {!id || runs.length === 0 ? (
        <div className="empty">
          <p className="empty-title">{t("conv.emptyTitle")}</p>
          <p className="quiet">{t("conv.emptyHint")}</p>
        </div>
      ) : (
        <ol className="turns" ref={list}>
          {runs.map((run, index) => (
            <Turn key={run.id} run={run} receipts={detail?.receipts[run.id] ?? []} activity={detail?.activity[run.id] ?? []}
              live={live[run.id]} highlighted={highlighted.has(run.id)} askedOn={askedOn(run, runs[index - 1])} startedBy={startedBy(run)} />
          ))}
        </ol>
      )}
      {offer && (
        <div className="suggestions" role="group" aria-label={t("chips.label")}>
          {suggestions.map((text) => <button type="button" key={text} className="suggestion" onClick={() => send(undefined, text)}>{text}</button>)}
        </div>
      )}
      <form className="composer" onSubmit={send}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
          rows={Math.min(6, Math.max(1, draft.split("\n").length))}
          placeholder={t(working ? "composer.working" : id ? "composer.continue" : "composer.new")}
          aria-label={t("composer.label")}
          maxLength={8000}
        />
        <button type="submit" disabled={!draft.trim() || sending} aria-label={t("composer.send")}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>
        </button>
      </form>
      {error && <p className="problem small composer-error" role="alert">{error}</p>}
    </section>
  );
}
