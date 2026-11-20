import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ConversationDetail, CoreEvent, EngineModel, FileInfo, Run, RunRequest, SessionMode, ThinkingLevel, ViewContext } from "@alfred/protocol";
import { ApiError, api } from "./api.ts";
import { Logo, modelMark } from "./brand/Logo.tsx";
import { t, type Key } from "./i18n/index.ts";
import { describeReceipt, errorText } from "./receipts.ts";
import { Diff } from "./Diff.tsx";
import { Linked } from "./Linked.tsx";
import { Markdown } from "./Markdown.tsx";
import { Icon } from "./shell/icons.tsx";
import { MicButton } from "./voice/MicButton.tsx";
import { appendDictation } from "./voice/wav.ts";
import { AttachButton, AttachChips, SentFiles, useAttachments } from "./attach.tsx";
import { sends } from "./prefs.ts";

const BUSY = new Set<Run["state"]>(["queued", "running", "cancelling"]);

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
/** 950, 1.2k, 34k, 1.3M */
const compact = (n: number) => n < 1000 ? String(Math.round(n)) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
const dollars = (n: number) => n <= 0 ? null : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
const took = (ms: number) => ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

interface Spent { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
const spent = (events: CoreEvent[]): Spent => events.reduce((sum, event) => ({
  input: sum.input + num(event.payload.input), output: sum.output + num(event.payload.output),
  cacheRead: sum.cacheRead + num(event.payload.cacheRead), cacheWrite: sum.cacheWrite + num(event.payload.cacheWrite),
  cost: sum.cost + num(event.payload.cost),
}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
/** The lines of a usage tooltip: tokens in and out, cache, cost. */
const spentLines = (total: Spent) => [
  `${t("stats.in")} ${total.input.toLocaleString()}`, `${t("stats.out")} ${total.output.toLocaleString()}`,
  ...(total.cacheRead > 0 ? [`${t("stats.cacheRead")} ${total.cacheRead.toLocaleString()}`] : []),
  ...(total.cacheWrite > 0 ? [`${t("stats.cacheWrite")} ${total.cacheWrite.toLocaleString()}`] : []),
  ...(total.cost > 0 ? [`${t("stats.cost")} $${total.cost.toFixed(4)}`] : []),
];

/** The current time, ticking each second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/** Where a reply stands, shown by the dot beside it, and the one line on what it is doing while it works. */
type Phase = "idle" | "busy" | "waiting" | "failed";
function phase(run: Run, live: string | undefined, runSteps: Array<{ label: string; about: string; status: string; command: boolean }>): { dot: Phase; label: string | null } {
  if (run.request) return { dot: "waiting", label: null };
  switch (run.state) {
    case "queued": return { dot: "busy", label: t("run.queued") };
    case "cancelling": return { dot: "busy", label: t("run.cancelling") };
    case "running": {
      const step = runSteps.findLast((candidate) => candidate.status === "started");
      if (step) return { dot: "busy", label: step.command ? step.about : step.label };
      return { dot: "busy", label: live ? null : t("run.thinking") };
    }
    case "failed": case "interrupted": return { dot: "failed", label: null };
    default: return { dot: "idle", label: null };
  }
}

interface Step {
  id: string; label: string; about: string; status: string;
  /** A command: its exit code once it ended (null: it was stopped), how long it ran, and the end of what it printed. */
  command: boolean; exit?: number | null; ms?: number; output?: string;
}

/** Steps of a run, one line per tool call, at its latest status. */
function steps(activity: CoreEvent[]): Step[] {
  const byStep = new Map<string, Step>();
  for (const event of activity) {
    if (event.kind !== "run.step") continue;
    const id = String(event.payload.step);
    const exit = event.payload.exit;
    byStep.set(id, {
      id, label: String(event.payload.label ?? event.payload.tool), about: String(event.payload.about ?? ""), status: String(event.payload.status),
      command: event.payload.tool === "bash",
      ...(typeof exit === "number" || exit === null ? { exit } : {}),
      ...(typeof event.payload.ms === "number" ? { ms: event.payload.ms } : {}),
      ...(typeof event.payload.output === "string" ? { output: event.payload.output } : {}),
    });
  }
  return [...byStep.values()].filter((step) => step.label !== "Ask");
}

/** A command as a step: the command itself, how it ended, and what it printed, folded away. */
function CommandStep({ step }: { step: Step }) {
  const ended = step.status === "done" || step.status === "failed";
  const how = !ended ? null : step.exit === null || step.exit === undefined ? t("cmd.stopped") : step.exit === 0 ? null : t("cmd.exit", { code: step.exit });
  const line = (
    <>
      <span aria-hidden="true">{STEP_MARK[step.status] ?? "·"}</span> <code className="step-command">{step.about}</code>
      {(how || step.ms !== undefined) && <span className="step-end">{[how, step.ms !== undefined ? took(step.ms) : null].filter(Boolean).join(" · ")}</span>}
    </>
  );
  if (!step.output) return <li data-status={step.status}>{line}</li>;
  return (
    <li data-status={step.status}>
      <details className="step-output">
        <summary>{line}</summary>
        <pre>{step.output}</pre>
      </details>
    </li>
  );
}

const STEP_MARK: Record<string, string> = { started: "…", done: "✓", failed: "✗", declined: "—" };

export function Request({ run, request }: { run: Run; request: RunRequest }) {
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
  const command = request.detailKind === "command";
  return (
    <div className="request" data-kind={request.kind} role="group" aria-label={t(permission ? "req.permission" : "req.input")}>
      <p className="request-question"><Linked text={request.question} /></p>
      {request.detail && (command ? <pre className="request-command">{request.detail}</pre> : <Diff patch={request.detail} />)}
      <div className="request-options">
        {permission ? (
          <>
            <button type="button" disabled={busy} onClick={() => answer("allow")}>{t("common.allow")}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => answer("deny")}>{t("common.deny")}</button>
            {request.options.includes("always") && (
              <button type="button" className="ghost" disabled={busy} onClick={() => answer("always")} title={command ? t("req.alwaysCommandTitle", { command: request.grant ?? "" }) : t("req.alwaysTitle")}>{t(command ? "req.alwaysCommand" : "req.always")}</button>
            )}
          </>
        ) : request.options.map((option) => (
          <button type="button" key={option} disabled={busy} onClick={() => answer(option)}>{option}</button>
        ))}
      </div>
      {!permission && (
        <form className="request-free" onSubmit={(event) => { event.preventDefault(); answer(text); }}>
          <span className="with-mic">
            <input value={text} onChange={(event) => setText(event.target.value)} placeholder={t("req.free")} aria-label={t("req.answer")} maxLength={2000} disabled={busy} />
            <MicButton className="small" disabled={busy} onText={(words) => setText((now) => appendDictation(now, words))} />
          </span>
        </form>
      )}
      {error && <p className="problem small" role="alert">{error}</p>}
    </div>
  );
}

function Turn({ run, receipts, activity, files, live, highlighted, askedOn, startedBy, latest }: { run: Run; receipts: CoreEvent[]; activity: CoreEvent[]; files?: FileInfo[]; live?: string; highlighted: boolean; askedOn?: string; startedBy?: string; latest: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action().catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const outcome = run.outcome;
  const runSteps = steps(activity);
  const answers = activity.filter((event) => event.kind === "run.answered");
  const added = activity.filter((event) => event.kind === "run.steered");
  const usage = activity.filter((event) => event.kind === "run.usage").at(-1);
  const working = BUSY.has(run.state);
  const now = useNow(working);
  const { dot, label } = phase(run, live, runSteps);
  const elapsed = working ? Math.max(0, now - Date.parse(run.createdAt)) : num(usage?.payload.durationMs) || Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt));

  const model = typeof usage?.payload.model === "string" ? usage.payload.model : null;
  const mark = modelMark(model);
  const total = usage ? spent([usage]) : null;
  const meta = !working && usage ? [
    ...(model ? [model.split("/").at(-1)!] : []),
    took(elapsed),
    ...(total && (total.input || total.output) ? [`↑${compact(total.input)} ↓${compact(total.output)}`] : []),
    ...(total && dollars(total.cost) ? [dollars(total.cost)!] : []),
  ] : [];
  const metaTitle = usage ? [model, `${t("stats.time")} ${took(elapsed)}`, ...(total && (total.input || total.output) ? spentLines(total) : [])].filter(Boolean).join("\n") : undefined;

  return (
    <li className="turn" data-highlighted={highlighted || undefined} id={`run-${run.id}`}>
      {askedOn && <p className="asked-on">{t("conv.askedFrom", { page: askedOn })}</p>}
      {/* An automation's run: nobody said anything; say which automation started it, and when. */}
      {startedBy ? <p className="asked-on auto-from" title={run.goal}>{startedBy}</p> : <p className="said"><Linked text={run.goal} /></p>}
      <SentFiles files={files} />
      {added.map((event) => <p className="said added" key={event.id}><Linked text={String(event.payload.text)} /></p>)}
      <div className="reply-row">
        <span className="turn-dot" data-phase={dot} data-latest={latest || undefined} aria-hidden="true" />
        <div className="reply-col">
          <div className="reply" data-state={run.state}>
            {runSteps.length > 0 && (
              <ol className="steps" aria-label={t("run.steps")}>
                {runSteps.map((step) => step.command ? <CommandStep key={step.id} step={step} /> : (
                  <li key={step.id} data-status={step.status}><span aria-hidden="true">{STEP_MARK[step.status] ?? "·"}</span> {step.label}{step.about ? `：${step.about}` : ""}</li>
                ))}
              </ol>
            )}
            {answers.map((event) => (
              <p className="answered small" key={event.id}>{String(event.payload.question)} → {event.payload.kind === "permission" ? t(event.payload.answer === "allow" ? "run.allowed" : event.payload.answer === "always" ? "run.always" : "run.denied") : String(event.payload.answer)}</p>
            ))}
            {run.request && <Request run={run} request={run.request} />}
            {working && !run.request && (label || !live) && (
              <p className="working" role="status"><span className="working-label">{label ?? t("run.writing")}</span><span className="elapsed">{took(elapsed).replace(/\.\d/, "")}</span></p>
            )}
            {live && !outcome && <Markdown className="reply-text live" text={live} />}
            {outcome?.reply && <Markdown className="reply-text" text={outcome.reply} />}
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
          </div>
          {meta.length > 0 && <p className="run-meta" title={metaTitle}>{meta.map((part, index) => <span key={part}>{mark && index === 0 && <Logo name={mark} />}{part}</span>)}</p>}
          {error && <p className="problem small" role="alert">{error}</p>}
        </div>
      </div>
    </li>
  );
}

const MODES: SessionMode[] = ["plan", "ask", "edits"];
const THINKING: Array<[ThinkingLevel | "", Key]> = [["", "think.default"], ["off", "think.off"], ["low", "think.low"], ["medium", "think.medium"], ["high", "think.high"]];
let modelList: Promise<EngineModel[]> | null = null;

/** The top of a conversation: its title and how much it has used. Nothing to change here; that is under the composer. */
function ConversationHead({ title, detail }: { title: string; detail: ConversationDetail | null }) {
  const usages = detail ? Object.values(detail.activity).flat().filter((event) => event.kind === "run.usage").sort((a, b) => a.seq - b.seq) : [];
  const usage = usages.at(-1);
  const percent = typeof usage?.payload.percent === "number" ? Math.round(usage.payload.percent) : null;
  return (
    <header className="conversation-head">
      <h1>{title}</h1>
      <Stats total={spent(usages)} percent={percent} window={num(usage?.payload.contextWindow)} />
    </header>
  );
}

/** Under the composer: what the next turn runs on, the conversation's model and thinking level. Unset means Pi's
 * defaults. A new conversation has none to set until its first message creates it. */
function ComposerBar({ conversation, onError }: { conversation: ConversationDetail["conversation"] | undefined; onError(message: string | null): void }) {
  const [models, setModels] = useState<EngineModel[]>([]);
  const exists = !!conversation;
  useEffect(() => {
    if (!exists) return;
    modelList ??= api.models().then((response) => response.models).catch(() => { modelList = null; return []; });
    void modelList.then(setModels);
  }, [exists]);
  if (!conversation) return null;
  const change = (patch: { model?: string | null; thinking?: ThinkingLevel | null; mode?: SessionMode }) => {
    onError(null);
    api.updateConversation(conversation.id, patch).catch((reason: Error) => onError(reason.message));
  };
  const known = new Set(models.map((model) => `${model.provider}/${model.id}`));
  const mark = modelMark(conversation.model);
  return (
    <>
      <label className="pick" title={t("conv.model")}>
        {mark ? <Logo name={mark} /> : <Icon name="model" />}
        <select aria-label={t("conv.model")} value={conversation.model ?? ""} onChange={(event) => change({ model: event.target.value || null })}>
          <option value="">{t("conv.defaultModel")}</option>
          {conversation.model && !known.has(conversation.model) && <option value={conversation.model}>{conversation.model.split("/").at(-1)}</option>}
          {models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}
        </select>
      </label>
      <label className="pick" title={t("conv.thinking")}>
        <Icon name="bulb" />
        <select aria-label={t("conv.thinking")} value={conversation.thinking ?? ""} onChange={(event) => change({ thinking: (event.target.value || null) as ThinkingLevel | null })}>
          {THINKING.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </label>
      {conversation.projectId && (
        <label className="pick mode" data-mode={conversation.mode ?? "plan"} title={t("mode.title")}>
          <Icon name="shield" />
          <select aria-label={t("mode.title")} value={conversation.mode ?? "plan"} onChange={(event) => change({ mode: event.target.value as SessionMode })}>
            {MODES.map((mode) => <option key={mode} value={mode}>{t(`mode.${mode}` as Key)}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

/** How much the conversation has used, after pi web: tokens in and out, cost, and how full the context is. */
function Stats({ total, percent, window }: { total: Spent; percent: number | null; window: number }) {
  if (!total.input && !total.output && percent === null) return null;
  const cost = dollars(total.cost);
  const level = percent === null ? undefined : percent > 90 ? "full" : percent > 70 ? "high" : undefined;
  const title = [
    ...(total.input || total.output ? spentLines(total) : []),
    ...(percent !== null && window ? [t("stats.context", { n: percent, window: compact(window) })] : []),
  ].join("\n");
  return (
    <span className="conv-stats" role="group" aria-label={t("stats.label")} title={title}>
      {total.input > 0 && <span>↑{compact(total.input)}</span>}
      {total.output > 0 && <span>↓{compact(total.output)}</span>}
      {cost && <span>{cost}</span>}
      {percent !== null && (
        <span className="ctx" data-level={level}>
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" />
            <circle cx="7" cy="7" r="5.5" pathLength="100" strokeDasharray={`${Math.max(percent, 2)} 100`} transform="rotate(-90 7 7)" />
          </svg>
          {percent}%
        </span>
      )}
    </span>
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
  /** In Alfred's panel beside a daily page: the words and what was done, and nothing about the model. No title and
   * usage row, no model and thinking under the composer, and suggestions only before the first question. */
  slim?: boolean;
}

export function Conversation({ id, live, highlighted, context, suggestions, pageTitle, automationTitle, onEvent, onView, onStarted, slim }: ConversationProps) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | null>(null);
  // The latest onView, without being a reason to load again: the parent hands a new function on every render, and
  // reloading for it emptied the list on every streamed word.
  const view = useRef(onView);
  view.current = onView;
  const attachments = useAttachments();

  useEffect(() => {
    setDetail(null);
    if (!id) return;
    let alive = true;
    const load = () => api.conversation(id).then((next) => { if (alive) setDetail(next); })
      .catch((reason: Error) => { if (alive) setError(reason instanceof ApiError && reason.code === "needs_dev" ? t("dev.needsScope") : reason.message); });
    void load();
    const off = onEvent((event) => {
      // Anything about this conversation or any run may concern it; reloading is cheap and local.
      if (event.subject !== `conversation:${id}` && !event.runId) return;
      if (event.kind === "run.view" && event.runId) {
        // Only views opened now, by a run here: not ones replayed from history.
        api.run(event.runId).then(({ run }) => { if (run.conversationId === id) view.current(String(event.payload.module), String(event.payload.view)); }).catch(() => {});
      }
      if (timer.current === null) timer.current = window.setTimeout(() => { timer.current = null; void load(); }, 100);
    });
    return () => { alive = false; off(); };
  }, [id, onEvent]);

  const runs = detail?.runs ?? [];
  const last = runs.at(-1);
  // The stream ends a moment before the finished reply loads. The words stay up for that moment, so the reply does
  // not empty and fill again.
  const spoken = useRef<Record<string, string>>({});
  for (const [runId, text] of Object.entries(live)) spoken.current[runId] = text;
  const liveOf = (run: Run) => live[run.id] ?? (BUSY.has(run.state) ? spoken.current[run.id] : undefined);
  // The list stays at its end while you are there, and stays put once you scroll up to read. A new turn takes you
  // back to the end. Set, not animated: an animation restarted on every streamed word never arrives.
  const atEnd = useRef(true);
  const onScroll = () => {
    const el = list.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useLayoutEffect(() => { atEnd.current = true; }, [last?.id]);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  });

  // While a run works, what you say joins it, as in Claude; otherwise it is the next request.
  const working = last?.state === "running" ? last : null;
  const send = (event?: FormEvent, text = draft) => {
    event?.preventDefault();
    // Files alone are a message too: they go with a few words of their own.
    const files = attachments.ids;
    const goal = text.trim() || (files.length ? t("attach.look") : "");
    if (!goal || sending || attachments.busy) return;
    setSending(true);
    setError(null);
    const submit = () => api.submit(goal, id ?? undefined, context, files).then(({ run }) => { attachments.clear(); if (!id) onStarted(run.conversationId); });
    // Words can join the turn that is working; files cannot, so with files it is the next message.
    const attempt = working && !files.length
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
    // Enter sends and Shift+Enter breaks the line, or ⌘Enter sends (Settings → General); never while an IME is composing.
    if (sends(event)) send(event);
  };

  // Which page a question came from, said once each time it changes, not on every turn.
  const startedBy = (run: Run) => run.automationId
    ? t("auto.fromAt", { name: automationTitle(run.automationId) ?? t("auto.removed"), at: new Date(run.createdAt).toTimeString().slice(0, 5) })
    : undefined;
  const askedOn = (run: Run, previous: Run | undefined) =>
    run.context && run.context.view !== previous?.context?.view ? pageTitle(run.context.view) ?? run.context.title ?? run.context.view : undefined;
  const offer = !draft.trim() && !working && !sending && suggestions.length > 0 && (!slim || runs.length === 0);

  return (
    <section className="conversation" data-slim={slim || undefined} aria-label={detail?.conversation.title ?? t("conv.new")}>
      {!slim && <ConversationHead title={id ? detail?.conversation.title ?? "…" : t("conv.new")} detail={detail} />}
      {!id || runs.length === 0 ? (
        <div className="empty">
          <p className="empty-title">{t("conv.emptyTitle")}</p>
          <p className="quiet">{t("conv.emptyHint")}</p>
        </div>
      ) : (
        <ol className="turns" ref={list} onScroll={onScroll}>
          {runs.map((run, index) => (
            <Turn key={run.id} run={run} receipts={detail?.receipts[run.id] ?? []} activity={detail?.activity[run.id] ?? []}
              files={detail?.files?.[run.id]} live={liveOf(run)} highlighted={highlighted.has(run.id)} askedOn={askedOn(run, runs[index - 1])} startedBy={startedBy(run)} latest={index === runs.length - 1} />
          ))}
        </ol>
      )}
      {offer && (
        <div className="suggestions" role="group" aria-label={t("chips.label")}>
          {suggestions.map((text) => <button type="button" key={text} className="suggestion" onClick={() => send(undefined, text)}>{text}</button>)}
        </div>
      )}
      <form className="composer" onSubmit={send} onPaste={attachments.onPaste} onDrop={attachments.onDrop} onDragOver={attachments.onDragOver}>
        <AttachChips attachments={attachments} />
        <textarea
          ref={field}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
          rows={Math.min(6, Math.max(1, draft.split("\n").length))}
          placeholder={t(working ? "composer.working" : id ? "composer.continue" : "composer.new")}
          aria-label={t("composer.label")}
          maxLength={8000}
        />
        <div className="composer-bar">
          {!slim && <ComposerBar conversation={detail?.conversation} onError={setError} />}
          <span className="grow" />
          <AttachButton attachments={attachments} />
          <MicButton onText={(words) => { setDraft((now) => appendDictation(now, words)); field.current?.focus(); }} />
          <button type="submit" className="send" disabled={(!draft.trim() && !attachments.ids.length) || sending || attachments.busy} aria-label={t("composer.send")}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>
          </button>
        </div>
      </form>
      {error && <p className="problem small composer-error" role="alert">{error}</p>}
    </section>
  );
}
