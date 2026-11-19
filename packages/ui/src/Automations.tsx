import { useEffect, useState, type FormEvent } from "react";
import type { Automation, StateResponse } from "@alfred/protocol";
import { api } from "./api.ts";
import { automationTitle, scheduleText, whenText } from "./automationText.ts";
import { Linked } from "./Linked.tsx";
import { Icon } from "./shell/icons.tsx";
import { t, type Key } from "./i18n/index.ts";

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
function lastText(automation: Automation): string {
  const run = automation.lastRun;
  if (!run) return t("auto.never");
  if (run.state === "queued" || run.state === "running" || run.state === "cancelling") return t("auto.lastRunning");
  if (run.state === "failed" || run.state === "interrupted") return t("auto.lastFailed", { when: whenText(run.at) });
  return t("auto.last", { when: whenText(run.at) });
}

/** Making or changing one: what to do (unless it is a template), and when. */
function AutomationForm({ automation, onDone }: { automation?: Automation; onDone(): void }) {
  const template = automation?.template ?? null;
  const [name, setName] = useState(automation?.name ?? "");
  const [goal, setGoal] = useState(automation?.goal ?? "");
  const [at, setAt] = useState(automation?.schedule.at ?? "08:00");
  const [days, setDays] = useState<number[]>(automation?.schedule.days ?? EVERY_DAY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = t("auto.dayNames").split(",");
  const ready = /^\d\d:\d\d$/.test(at) && days.length > 0 && (template !== null || (name.trim() && goal.trim()));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const schedule = { at, days };
    const request = automation
      ? api.updateAutomation(automation.id, template ? { schedule } : { name: name.trim(), goal: goal.trim(), schedule })
      : api.createAutomation({ name: name.trim(), goal: goal.trim(), schedule });
    request.then(onDone).catch((reason: Error) => { setError(reason.message); setBusy(false); });
  };
  const toggleDay = (day: number) => setDays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort());

  return (
    <form className="auto-form" onSubmit={submit} aria-label={automation ? automationTitle(automation) : t("auto.newTitle")}>
      {template === null && (
        <>
          <label className="field">
            <span>{t("auto.name")}</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("auto.namePlaceholder")} maxLength={60} autoFocus={!automation} />
          </label>
          <label className="field">
            <span>{t("auto.goal")}</span>
            <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t("auto.goalPlaceholder")} maxLength={2000} rows={3} />
          </label>
        </>
      )}
      <div className="auto-when">
        <label className="field">
          <span>{t("auto.time")}</span>
          <input type="time" value={at} onChange={(event) => setAt(event.target.value)} required />
        </label>
        <div className="field" role="group" aria-label={t("auto.days")}>
          <span>{t("auto.days")}</span>
          <div className="day-picks">
            {EVERY_DAY.map((day) => (
              <button type="button" key={day} className="day-pick" aria-pressed={days.includes(day)} onClick={() => toggleDay(day)}>{names[day - 1]}</button>
            ))}
          </div>
        </div>
      </div>
      {days.length === 0 && <p className="quiet small">{t("auto.daysNeeded")}</p>}
      {error && <p className="problem small" role="alert">{error}</p>}
      <div className="auto-form-actions">
        <button type="submit" disabled={!ready || busy}>{t(automation ? "auto.save" : "auto.create")}</button>
        <button type="button" className="ghost" onClick={onDone}>{t("common.cancel")}</button>
      </div>
    </form>
  );
}

function AutomationRow({ automation, onOpenConversation }: { automation: Automation; onOpenConversation(conversationId: string, runId?: string): void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const act = <T,>(action: () => Promise<T>, then?: (result: T) => void) => {
    setBusy(true);
    setError(null);
    action().then((result) => then?.(result)).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const title = automationTitle(automation);
  const about = automation.goal ?? (automation.template ? t(`auto.tpl.${automation.template}.goal` as Key) : "");
  const remove = () => {
    if (!confirming) return setConfirming(true);
    setConfirming(false);
    act(() => api.deleteAutomation(automation.id));
  };

  if (editing) return <li className="auto-row editing"><AutomationForm automation={automation} onDone={() => setEditing(false)} /></li>;
  return (
    <li className="auto-row" data-enabled={automation.enabled || undefined}>
      <div className="auto-name" data-k={automation.template === "brief" ? "orange" : "green"}>
        <i><Icon name="clock" /></i>
        <span>
          <b>{title}</b>
          <small title={about}>{about}</small>
        </span>
      </div>
      <div className="auto-sched">
        <span>{scheduleText(automation.schedule)}</span>
        <small>{automation.enabled && automation.nextAt ? t("auto.next", { when: whenText(automation.nextAt) }) : t("auto.off")}</small>
      </div>
      <div className="auto-last" data-state={automation.lastRun?.state}>
        {automation.conversationId && automation.lastRun
          ? <button type="button" className="link" onClick={() => onOpenConversation(automation.conversationId!, automation.lastRun!.id)} aria-label={`${lastText(automation)} · ${t("auto.open")}`}>{lastText(automation)}</button>
          : <span>{lastText(automation)}</span>}
        {automation.lastRun?.reply && <small><Linked text={automation.lastRun.reply} /></small>}
      </div>
      <div className="auto-actions">
        <button type="button" className="switch" role="switch" aria-checked={automation.enabled} disabled={busy} aria-label={t("auto.toggle", { name: title })}
          onClick={() => act(() => api.updateAutomation(automation.id, { enabled: !automation.enabled }))} />
        <button type="button" className="ghost small" disabled={busy}
          onClick={() => act(() => api.runAutomation(automation.id), (run) => onOpenConversation(run.conversationId, run.id))}>{t("auto.runNow")}</button>
        <button type="button" className="ghost small" disabled={busy} onClick={() => setEditing(true)}>{t("auto.edit")}</button>
        <button type="button" className={confirming ? "ghost small danger" : "ghost small"} disabled={busy} onClick={remove}>{t(confirming ? "auto.confirmDelete" : "auto.delete")}</button>
      </div>
      {error && <p className="problem small auto-error" role="alert">{error}</p>}
    </li>
  );
}

/** The automations page: each rule, when it fires next, how it last went; switch, run now, change, delete, add. */
export function Automations({ state, onOpenConversation }: { state: StateResponse; onOpenConversation(conversationId: string, runId?: string): void }) {
  const [adding, setAdding] = useState(false);
  const automations = state.automations ?? [];
  return (
    <section className="automations" aria-label={t("auto.label")}>
      <p className="auto-note quiet">{t("auto.note")}</p>
      {automations.length === 0 && !adding && <p className="quiet empty-list">{t("auto.sum.empty")}</p>}
      <ul className="auto-list">
        {automations.map((automation) => <AutomationRow key={automation.id} automation={automation} onOpenConversation={onOpenConversation} />)}
        {adding && <li className="auto-row editing"><AutomationForm onDone={() => setAdding(false)} /></li>}
      </ul>
      {!adding && (
        <button type="button" className="auto-add" onClick={() => setAdding(true)}><Icon name="plus" />{t("auto.new")}</button>
      )}
    </section>
  );
}
