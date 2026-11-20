/** The mail page: the Gmail inbox's last two weeks, read one message at a time, and answered from here.
 *
 * Under an open mail: draft a reply (Alfred writes one), reply in a line (a few words in the bar under the page, and
 * Alfred writes it out), or write it yourself. A draft is shown where it will go, under the mail it answers, and its
 * text can be changed by hand before it is sent. Alfred's drafts are proposals (they wait on the home node, and show
 * in 通知 too); a draft the user wrote, or took over by editing Alfred's, is kept on this device until it is sent.
 * Nothing goes out without a press on 发送: Alfred's as it stands is the proposal accepted, anything else is the
 * user's own `mail.send`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Proposal, Run, StateResponse } from "@alfred/protocol";
import type { MailDetail, MailMessage, MailSent, MailSnapshot, SendInput } from "@alfred/module-mail/types";
import { api } from "./api.ts";
import { outcomeText } from "./Inbox.tsx";
import { Linked, OutLink } from "./Linked.tsx";
import { SourceBar } from "./SourceBar.tsx";
import type { PageLine, Picked } from "./shell/about.ts";
import { MicButton } from "./voice/MicButton.tsx";
import { appendDictation } from "./voice/wav.ts";
import { intlLocale, t, type Key } from "./i18n/index.ts";

type Filter = "primary" | "unread" | "all" | "drafts";
const FILTERS: Array<[Filter, Key]> = [["primary", "mail.primary"], ["unread", "mail.unread"], ["all", "mail.all"], ["drafts", "mail.drafts"]];

const VIEW = "mail.inbox";
/** What a run asked for a new email (not a reply) has picked. */
const COMPOSE = "compose";
const GOING = new Set<Run["state"]>(["queued", "running", "cancelling"]);

/** A draft: Alfred's (a step of an open proposal) or the user's own (kept on this device). */
type Draft =
  | { kind: "alfred"; key: string; input: SendInput; at: string; proposal: Proposal; index: number }
  | { kind: "own"; key: string; input: SendInput; at: string };
interface OwnDraft { key: string; input: SendInput; at: string }

const messageKey = (message: Pick<MailMessage, "account" | "id">) => `${message.account}|${message.id}`;
const pickedOf = (message: MailMessage): Picked => ({ id: message.id, title: `${message.from}: ${message.subject}`.slice(0, 200) });
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Today's mail by its time, older mail by its date. */
function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

const OWN_KEY = "alfred.mail.drafts";
function readOwn(): OwnDraft[] {
  try {
    const kept = JSON.parse(localStorage.getItem(OWN_KEY) ?? "[]") as unknown;
    return Array.isArray(kept) ? kept.filter((draft): draft is OwnDraft => !!draft && typeof draft.key === "string" && Array.isArray(draft.input?.to) && typeof draft.input.body === "string") : [];
  } catch { return []; }
}
/** The user's own drafts, kept on this device so a reload or a failed send does not lose the words. */
function useOwnDrafts() {
  const [own, setOwn] = useState<OwnDraft[]>(readOwn);
  const change = useCallback((next: (now: OwnDraft[]) => OwnDraft[]) => setOwn((now) => {
    const made = next(now);
    try { localStorage.setItem(OWN_KEY, JSON.stringify(made)); } catch { /* private mode: kept while the page is open */ }
    return made;
  }), []);
  const put = useCallback((draft: OwnDraft) => change((now) => [...now.filter((other) => other.key !== draft.key), draft]), [change]);
  const drop = useCallback((key: string) => change((now) => now.filter((other) => other.key !== key)), [change]);
  return { own, put, drop };
}

interface Acts {
  send(draft: Draft, body: string): Promise<void>;
  discard(draft: Draft): Promise<void>;
  /** Puts the draft in the bar under the page: the next words there are what to change. */
  change(draft: Draft, body: string): void;
  /** The user's own draft as they type it. */
  keep(draft: Draft, body: string): void;
}

/** One draft, where it will go: who it is for, its text (changed by hand, if it is the only thing to decide), and
 * send, change, or not. */
function DraftCard({ draft, acts, changing, heading, arrived }: { draft: Draft; acts: Acts; changing: boolean; heading?: boolean; /** It came while the mail was being read. */ arrived?: boolean }) {
  const { input } = draft;
  const others = draft.kind === "alfred" ? draft.proposal.steps.filter((_, index) => index !== draft.index) : [];
  const stale = draft.kind === "alfred" && !!draft.proposal.stale;
  // A proposal with more steps is accepted as it was shown; its words change through Alfred.
  const editable = others.length === 0 && !stale;
  const [text, setText] = useState(input.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // A draft that turns up under the mail being read is brought into sight; opening a mail starts at its top.
    if (arrived) root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // A draft the user just started is theirs to type in.
    if (draft.kind === "own" && !input.body) field.current?.focus();
  }, []);
  const act = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    action().catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const write = (next: string) => { setText(next); if (draft.kind === "own") acts.keep(draft, next); };
  return (
    <section className="mail-draft" ref={root} data-own={draft.kind === "own" || undefined} data-on={changing || undefined} aria-label={t(draft.kind === "own" ? "mail.draft.own" : "mail.draft.alfred")}>
      <p className="mail-draft-head">
        <b>{t(draft.kind === "own" ? "mail.draft.own" : "mail.draft.alfred")}</b>
        <span>{t("mail.to")} {input.to.join(", ")}{input.cc.length > 0 && ` · ${t("mail.cc")} ${input.cc.join(", ")}`}</span>
      </p>
      {heading && <p className="mail-draft-subject">{input.subject || t("mail.nosubject")}</p>}
      {editable ? (
        <span className="with-mic">
          <textarea ref={field} value={text} onChange={(event) => write(event.target.value)} rows={Math.min(14, Math.max(3, text.split("\n").length + 1))} maxLength={20_000}
            placeholder={t("mail.own.placeholder")} aria-label={t("mail.draft.text")} disabled={busy} />
          <MicButton className="small" disabled={busy} onText={(words) => write(appendDictation(text, words))} />
        </span>
      ) : <p className="mail-draft-text">{input.body}</p>}
      {others.length > 0 && <ul className="mail-draft-also">{others.map((step, n) => <li key={n}>{step.preview}</li>)}</ul>}
      {stale && <p className="problem small">{t("inbox.staleWarn")}</p>}
      <div className="inbox-actions">
        {!stale && (
          <button type="button" disabled={busy || !text.trim()} onClick={() => act(() => acts.send(draft, text))}>
            {others.length ? t("inbox.acceptN", { n: others.length + 1 }) : t("mail.send")}
          </button>
        )}
        <button type="button" className="ghost" disabled={busy || !text.trim()} aria-pressed={changing} onClick={() => acts.change(draft, text)}>{t("mail.change")}</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => act(() => acts.discard(draft))}>{t("mail.discard")}</button>
      </div>
      {error && <p className="problem small" role="alert">{error}</p>}
    </section>
  );
}

const Writing = () => <p className="working mail-writing" role="status"><span className="working-label">{t("mail.writing")}</span></p>;

/** A reply that was sent from here, or is on its way, under the mail it answers. */
function SentCard({ sent, onAgain }: { sent: MailSent; onAgain?(): void }) {
  const label = sent.state === "done" ? `${t("mail.sent.done")} · ${when(sent.at)}`
    : sent.state === "failed" ? `${t("mail.sent.failed")}${sent.error ? `：${sent.error}` : ""}`
    : sent.state === "unknown" ? t("mail.sent.unknown") : t("mail.sent.going");
  return (
    <section className="mail-sent" data-state={sent.state}>
      <p className="mail-draft-head"><b>{label}</b></p>
      <p className="mail-draft-text">{sent.body}</p>
      {sent.state === "failed" && onAgain && <div className="inbox-actions"><button type="button" className="ghost" onClick={onAgain}>{t("mail.sent.again")}</button></div>}
    </section>
  );
}

interface ReaderProps {
  message: MailMessage;
  draft: Draft | undefined;
  writing: boolean;
  sent: MailSent[];
  canSend: boolean;
  line: PageLine;
  acts: Acts;
  /** Asks Alfred for a reply to this mail; `words` is what it should say, if the user gave any. */
  onDraft(words?: string): Promise<void>;
  /** Starts the user's own reply, empty or with the text of one that did not go out. */
  onOwn(body?: string): void;
  onBack(): void;
}

function Reader({ message, draft, writing, sent, canSend, line, acts, onDraft, onOwn, onBack }: ReaderProps) {
  const [detail, setDetail] = useState<MailDetail | "loading" | "gone">("loading");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDetail("loading");
    api.query<MailDetail | { error: string }>("mail.message", { id: message.id, account: message.account })
      .then((result) => { if (alive) setDetail("error" in result ? "gone" : result); })
      .catch(() => { if (alive) setDetail("gone"); });
    return () => { alive = false; };
  }, [message.id, message.account]);
  const reading = useRef(false);
  useEffect(() => { reading.current = true; }, []);
  const replyKey = `mail:reply:${messageKey(message)}`;
  const start = (words?: string) => { setError(null); return onDraft(words).catch((reason: Error) => { setError(reason.message); throw reason; }); };
  const inLine = () => line.attach(line.about === replyKey ? null : {
    key: replyKey, label: t("mail.reply.about", { who: short(message.from, 24) }), placeholder: t("mail.reply.placeholder"),
    chips: [t("mail.chip.yes"), t("mail.chip.no"), t("mail.chip.thanks")],
    send: (words) => start(words),
  });
  return (
    <article className="mail-read" aria-label={message.subject}>
      <button type="button" className="ghost small mail-back" onClick={onBack}>‹ {t("mail.back")}</button>
      <h2>{message.subject}</h2>
      <p className="mail-from"><b>{message.from}</b>{message.from !== message.fromEmail && <span className="quiet"> &lt;{message.fromEmail}&gt;</span>}</p>
      <p className="quiet small">
        {new Date(message.receivedAt).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" })}
        {typeof detail === "object" && detail.to && ` · ${t("mail.to")} ${detail.to}`}
      </p>
      {detail === "loading" && <p className="quiet">{t("mail.loading")}</p>}
      {detail === "gone" && <p className="quiet">{t("mail.gone")}</p>}
      {typeof detail === "object" && (
        <>
          <div className="mail-body"><Linked text={detail.body || detail.snippet} /></div>
          {detail.attachments.length > 0 && <p className="quiet small">{t("mail.attachments", { names: detail.attachments.join(", ") })}</p>}
          {detail.bodyIncomplete && <p className="quiet small">{t("mail.incomplete")}</p>}
        </>
      )}
      {sent.map((one) => <SentCard key={one.id} sent={one} onAgain={!draft && canSend ? () => onOwn(one.body) : undefined} />)}
      {draft ? <DraftCard key={draft.key} draft={draft} acts={acts} changing={line.about === `mail:change:${draft.key}`} arrived={reading.current} />
        : writing ? <Writing />
        : (
          <div className="mail-reply">
            <div className="inbox-actions">
              <button type="button" onClick={() => { void start().catch(() => {}); }}>{t("mail.reply.draft")}</button>
              <button type="button" className="ghost" aria-pressed={line.about === replyKey} onClick={inLine}>{t("mail.reply.line")}</button>
              {canSend && <button type="button" className="ghost" onClick={() => onOwn()}>{t("mail.reply.own")}</button>}
            </div>
            {!canSend && <p className="quiet small"><a href="#p=core.settings">{t("mail.nosend")}</a></p>}
            {error && <p className="problem small" role="alert">{error}</p>}
          </div>
        )}
      <p><OutLink href={message.link}>{t("mail.open")}</OutLink></p>
    </article>
  );
}

export function Mail({ snapshot, state, line }: { snapshot: MailSnapshot | undefined; state: StateResponse; line: PageLine }) {
  const [filter, setFilter] = useState<Filter>("primary");
  /** `<account>|<id>` for a message; `d:<draft key>` for a draft with no message here (`d:new` while one is written). */
  const [picked, setPicked] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  /** Runs asked from here, by what they are about (a message's key, or COMPOSE), until the state has caught up. */
  const [follow, setFollow] = useState<Record<string, { run: string; at: number }>>({});
  const { own, put, drop } = useOwnDrafts();
  const messages = snapshot?.messages ?? [];
  const sources = snapshot?.sources ?? [];
  const sentMail = snapshot?.sent ?? [];
  const lineNow = useRef(line);
  lineNow.current = line;

  const runs = state.runs;
  const drafts = useMemo<Draft[]>(() => [
    ...(state.proposals ?? []).flatMap((proposal) => proposal.steps.flatMap((step, index): Draft[] => (step.op === "mail.send"
      ? [{ kind: "alfred", key: `${proposal.id}:${index}`, input: step.input as SendInput, at: proposal.createdAt, proposal, index }] : []))),
    ...own.map((draft): Draft => ({ kind: "own", ...draft })),
  ], [state.proposals, own]);

  /** The message a draft answers: the one it replies to, or the one picked when Alfred was asked for it. */
  const answers = useCallback((draft: Draft): string | null => {
    if (draft.input.replyTo) return `${draft.input.account}|${draft.input.replyTo.id}`;
    if (draft.kind !== "alfred") return null;
    const asked = runs.find((run) => run.id === draft.proposal.runId)?.context;
    return asked?.view === VIEW && asked.selection && asked.selection.id !== COMPOSE ? `${draft.input.account}|${asked.selection.id}` : null;
  }, [runs]);
  // Alfred's newest draft for a message comes before the user's own.
  const draftFor = (key: string) => drafts.filter((draft) => answers(draft) === key).sort((a, b) => (a.kind === b.kind ? b.at.localeCompare(a.at) : a.kind === "alfred" ? -1 : 1))[0];
  const isWriting = (thing: string, selection: string) => {
    const followed = follow[thing];
    if (followed) {
      const run = runs.find((candidate) => candidate.id === followed.run);
      if (run ? GOING.has(run.state) : Date.now() - followed.at < 15_000) return true;
    }
    return runs.some((run) => GOING.has(run.state) && run.context?.view === VIEW && run.context.selection?.id === selection);
  };
  const following = (thing: string) => (runId: string | null) => { if (runId) setFollow((now) => ({ ...now, [thing]: { run: runId, at: Date.now() } })); };

  const shown = messages.filter((message) => filter === "all" || (filter === "unread" ? message.unread : message.category === "primary"));
  const count = (which: Filter) => (which === "drafts" ? drafts.length : messages.filter((message) => which === "all" || (which === "unread" ? message.unread : message.category === "primary")).length);
  const open = messages.find((message) => messageKey(message) === picked);
  const openDraft = picked?.startsWith("d:") ? drafts.find((draft) => `d:${draft.key}` === picked) : undefined;
  const composing = isWriting(COMPOSE, COMPOSE);

  // A draft that is not under a message (a new email) is followed by the run that writes it: the pane waits while
  // Alfred writes, then shows what it made; a new version takes the place of the one it changed.
  const composeRun = follow[COMPOSE]?.run;
  useEffect(() => {
    if (!picked?.startsWith("d:") || openDraft || composing) return;
    const made = drafts.find((draft) => draft.kind === "alfred" && draft.proposal.runId === composeRun);
    const under = made && answers(made);
    setPicked(made ? (under && messages.some((message) => messageKey(message) === under) ? under : `d:${made.key}`) : null);
  }, [picked, openDraft, composing, composeRun, drafts]);
  // Another mail, or none: the words in the bar were about the one before.
  useEffect(() => {
    const about = lineNow.current.about;
    if (about?.startsWith("mail:") && about !== "mail:compose") lineNow.current.attach(null);
  }, [picked]);
  useEffect(() => { if (!said) return; const timer = window.setTimeout(() => setSaid(null), 5000); return () => window.clearTimeout(timer); }, [said]);

  const thingOf = (draft: Draft) => answers(draft) ?? COMPOSE;
  const pickedFor = (draft: Draft): Picked => {
    const message = messages.find((candidate) => messageKey(candidate) === answers(draft));
    return message ? pickedOf(message) : { id: COMPOSE, title: t("mail.compose.about") };
  };
  const sendOwn = async (draft: OwnDraft) => {
    const { result } = await api.op("mail.send", draft.input);
    const refused = (result as { error?: unknown } | null)?.error;
    if (typeof refused === "string") throw new Error(refused);
    drop(draft.key);
    if (!draft.input.replyTo) setSaid(t("mail.sent.queued"));
  };
  const acts: Acts = {
    async send(draft, text) {
      const body = text.trim();
      if (draft.kind === "own") return sendOwn({ key: draft.key, at: draft.at, input: { ...draft.input, body } });
      if (body === draft.input.body.trim()) {
        const { proposal } = await api.accept(draft.proposal.id);
        if (proposal.state !== "executed") throw new Error(outcomeText(proposal.state, proposal.outcome?.error));
        if (!draft.input.replyTo) setSaid(t("mail.sent.queued"));
        return;
      }
      // The user's own wording: Alfred's version gives way, and theirs goes as their own. It is kept here first, so
      // a send that fails leaves it to try again.
      const mine: OwnDraft = { key: answers(draft) ?? `new:${Date.now()}`, at: new Date().toISOString(), input: { ...draft.input, body } };
      put(mine);
      if (!answers(draft)) setPicked(`d:${mine.key}`);
      await api.decline(draft.proposal.id);
      await sendOwn(mine);
    },
    async discard(draft) {
      if (draft.kind === "own") drop(draft.key);
      else await api.decline(draft.proposal.id);
    },
    change(draft, text) {
      const key = `mail:change:${draft.key}`;
      if (line.about === key) { line.attach(null); return; }
      const body = text.trim(), thing = thingOf(draft), about = pickedFor(draft);
      line.attach({
        key, label: t("mail.change.about"), placeholder: t("mail.change.placeholder"),
        chips: [t("mail.chip.shorter"), t("mail.chip.warmer"), t("mail.chip.direct")],
        async send(words) {
          if (draft.kind === "alfred") {
            // What the user already changed by hand is where the new version starts.
            const edited = body !== draft.input.body.trim();
            following(thing)(await line.revise(draft.proposal.id, edited ? `${words}\n${t("mail.change.mine")}\n${body}` : words, about));
          } else {
            following(thing)(await line.ask(t("mail.goal.rework", { to: draft.input.to.join(", "), subject: short(draft.input.subject, 80), text: words, draft: body }), about));
            drop(draft.key);
          }
          if (thing === COMPOSE) setPicked("d:new");
        },
      });
    },
    keep(draft, body) { if (draft.kind === "own") put({ key: draft.key, at: draft.at, input: { ...draft.input, body } }); },
  };

  const draftReply = (message: MailMessage) => async (words?: string) => {
    const names = { who: message.from, subject: short(message.subject, 80) };
    following(messageKey(message))(await line.ask(words ? t("mail.goal.reply", { ...names, text: words }) : t("mail.goal.draft", names), pickedOf(message)));
  };
  const ownReply = (message: MailMessage) => (body = "") => put({
    key: messageKey(message), at: new Date().toISOString(),
    input: {
      account: message.account, to: [message.fromEmail.trim().toLowerCase()], cc: [], body,
      subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`, replyTo: { id: message.id, threadId: message.threadId },
    },
  });
  const compose = () => line.attach(line.about === "mail:compose" ? null : {
    key: "mail:compose", label: t("mail.compose.about"), placeholder: t("mail.compose.placeholder"),
    async send(words) {
      following(COMPOSE)(await line.ask(t("mail.goal.compose", { text: words }), { id: COMPOSE, title: t("mail.compose.about") }));
      setFilter("drafts");
      setPicked("d:new");
    },
  });

  const replied = new Set(sentMail.filter((sent) => sent.replyTo && sent.state === "done").map((sent) => `${sent.account}|${sent.replyTo}`));
  const pane = open ? (
    <Reader key={picked} message={open} draft={draftFor(messageKey(open))} writing={isWriting(messageKey(open), open.id)}
      sent={sentMail.filter((sent) => sent.replyTo === open.id && sent.account === open.account)}
      canSend={sources.find((source) => source.account === open.account)?.canSend ?? false}
      line={line} acts={acts} onDraft={draftReply(open)} onOwn={ownReply(open)} onBack={() => setPicked(null)} />
  ) : openDraft ? (
    <article className="mail-read" aria-label={openDraft.input.subject}>
      <button type="button" className="ghost small mail-back" onClick={() => setPicked(null)}>‹ {t("mail.back")}</button>
      <DraftCard key={openDraft.key} draft={openDraft} acts={acts} changing={line.about === `mail:change:${openDraft.key}`} heading />
    </article>
  ) : picked?.startsWith("d:") && composing ? (
    <article className="mail-read">
      <button type="button" className="ghost small mail-back" onClick={() => setPicked(null)}>‹ {t("mail.back")}</button>
      <Writing />
    </article>
  ) : <p className="mail-read quiet mail-pick">{t("mail.pick")}</p>;

  return (
    <section className="mail" aria-label={t("page.mail")}>
      <SourceBar module="mail" mark="gmail" sources={sources} notConnected={t("src.notConnected.mail")} />
      {sources.length > 0 && (
        <>
          <div className="chips" role="group">
            {FILTERS.filter(([id]) => id !== "drafts" || filter === "drafts" || drafts.length > 0 || composing).map(([id, label]) => (
              <button type="button" key={id} className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {t(label)}<span className="count">{count(id)}</span>
              </button>
            ))}
            <button type="button" className="chip mail-compose" aria-pressed={line.about === "mail:compose"} onClick={compose}>{t("mail.compose")}</button>
          </div>
          {said && <p className="inbox-said" role="status">{said}</p>}
          <div className="mail-split" data-reading={open || openDraft || (picked?.startsWith("d:") && composing) ? true : undefined}>
            <ul className="mail-list">
              {filter === "drafts" ? (
                <>
                  {composing && <li><button type="button" className="mail-row" aria-current={picked === "d:new" || undefined} onClick={() => setPicked("d:new")}><span className="mail-dot" aria-hidden="true" /><span className="mail-who working-label">{t("mail.writing")}</span></button></li>}
                  {drafts.length === 0 && !composing && <li className="quiet empty-list">{t("mail.empty.drafts")}</li>}
                  {drafts.map((draft) => {
                    const under = answers(draft);
                    const target = under && messages.some((message) => messageKey(message) === under) ? under : `d:${draft.key}`;
                    return (
                      <li key={draft.key}>
                        <button type="button" className="mail-row" aria-current={picked === target || undefined} onClick={() => setPicked(target)}>
                          <span className="mail-dot" aria-hidden="true" />
                          <span className="mail-who">{draft.input.to.join(", ")}</span>
                          <span className="mail-meta">{draft.kind === "alfred" && <span className="tag" data-k="alfred">Alfred</span>}<time>{when(draft.at)}</time></span>
                          <span className="mail-subject">{draft.input.subject || t("mail.nosubject")}</span>
                          <span className="mail-snippet">{draft.input.body.slice(0, 160)}</span>
                        </button>
                      </li>
                    );
                  })}
                </>
              ) : (
                <>
                  {shown.length === 0 && <li className="quiet empty-list">{t("mail.empty")}</li>}
                  {shown.map((message) => {
                    const key = messageKey(message);
                    return (
                      <li key={key}>
                        <button type="button" className="mail-row" data-unread={message.unread || undefined} aria-current={picked === key || undefined} onClick={() => setPicked(key)}>
                          <span className="mail-dot" aria-hidden="true" />
                          <span className="mail-who">{message.from}</span>
                          <span className="mail-meta">
                            {draftFor(key) ? <span className="tag" data-k="alfred">{t("mail.tag.draft")}</span> : replied.has(key) && <span className="tag">{t("mail.tag.replied")}</span>}
                            <time>{when(message.receivedAt)}</time>
                          </span>
                          <span className="mail-subject">{message.subject}</span>
                          <span className="mail-snippet">{message.snippet}</span>
                        </button>
                      </li>
                    );
                  })}
                </>
              )}
            </ul>
            {pane}
          </div>
        </>
      )}
    </section>
  );
}
