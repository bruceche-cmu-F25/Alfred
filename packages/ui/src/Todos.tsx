import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Area } from "@alfred/protocol";
import type { TodoSnapshot } from "@alfred/module-todo/types";
import { api } from "./api.ts";
import { Linked, OutLink } from "./Linked.tsx";
import { getLocale, t, type Key } from "./i18n/index.ts";

type Item = TodoSnapshot["todos"][number];

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(y, m - 1, d + days);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

/** The Sunday that ends the week `date` is in (weeks start on Monday). */
function weekEnd(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = (new Date(y, m - 1, d).getDay() + 6) % 7; // Monday 0 … Sunday 6
  return addDays(date, 6 - weekday);
}

function dueLabel(todo: Item, today: string): string | null {
  if (!todo.due) return null;
  if (todo.startDate && todo.startDate !== todo.due) return `${todo.startDate.slice(5)} – ${todo.due.slice(5)}`;
  if (todo.due === today) return t("todo.today");
  if (todo.due === addDays(today, 1)) return t("todo.tomorrow");
  if (todo.due < today) return t("todo.overdue", { date: todo.due.slice(5) });
  if (todo.due <= weekEnd(today)) { const [y, m, d] = todo.due.split("-").map(Number); return t("todo.weekdays").split(",")[new Date(y, m - 1, d).getDay()]; }
  return todo.due.slice(5);
}

/** Where a todo sits on the page. Ranges running today count as today. */
type Group = "late" | "today" | "tomorrow" | "week" | "later" | "someday";
const GROUPS: Array<[Group, Key]> = [["late", "todo.g.late"], ["today", "todo.g.today"], ["tomorrow", "todo.g.tomorrow"], ["week", "todo.g.week"], ["later", "todo.g.later"], ["someday", "todo.g.someday"]];
function groupOf(todo: Item, today: string): Group {
  if (!todo.due) return "someday";
  if (todo.startDate && todo.startDate <= today && todo.due >= today) return "today";
  if (todo.due < today) return "late";
  if (todo.due === today) return "today";
  if (todo.due === addDays(today, 1)) return "tomorrow";
  return todo.due <= weekEnd(today) ? "week" : "later";
}

const BY: Record<string, Key> = { "todo.added": "todo.by.added", "todo.completed": "todo.by.completed" };

function TodoRow({ todo, today, areas, fresh, onError }: { todo: Item; today: string; areas: Area[]; fresh: boolean; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const run = (op: string, input: unknown) => {
    setBusy(true);
    api.op(op, input).then((response) => {
      const result = response.result as { error?: string } | null;
      if (result && typeof result.error === "string") onError(result.error);
    }).catch((reason: Error) => onError(reason.message)).finally(() => setBusy(false));
  };
  const toggle = () => todo.done
    ? run("todo.update", { id: todo.id, revision: todo.revision, patch: { done: false } })
    : run("todo.complete", { id: todo.id, revision: todo.revision });
  const remove = () => {
    if (!confirming) return setConfirming(true);
    setConfirming(false);
    run("todo.delete", { id: todo.id, revision: todo.revision });
  };
  const setArea = (area: string) => run("todo.update", { id: todo.id, revision: todo.revision, patch: { area } });
  const area = areas.find((candidate) => candidate.id === todo.area);
  const due = dueLabel(todo, today);
  const overdue = !todo.done && !!todo.due && todo.due < today;

  return (
    <li className="todo" data-k={area?.k} data-done={todo.done || undefined} data-fresh={fresh || undefined}>
      <button type="button" className="check" role="checkbox" aria-checked={todo.done} disabled={busy} onClick={toggle}
        aria-label={t(todo.done ? "todo.uncheck" : "todo.check", { title: todo.title })}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.5l3 3 6-7" /></svg>
      </button>
      <div className="todo-body">
        {/* With a link of its own the whole title leads there; otherwise any address written in the title does. */}
        {todo.url ? <OutLink className="todo-title" href={todo.url}>{todo.title}</OutLink> : <span className="todo-title"><Linked text={todo.title} /></span>}
        <span className="todo-meta">
          <select className="tag area-pick" data-k={area?.k} data-empty={area ? undefined : true} value={todo.area ?? ""} disabled={busy}
            onChange={(event) => setArea(event.target.value)} aria-label={t("todo.areaOf", { title: todo.title })}>
            <option value="">{t(area ? "todo.noArea" : "todo.addArea")}</option>
            {areas.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name[getLocale()]}</option>)}
          </select>
          {todo.status === "doing" && !todo.done && <span className="tag" data-k="alfred">{t("todo.doing")}</span>}
          {due && <span className={overdue ? "due overdue" : "due"}>{due}</span>}
          {todo.plannedOn && !todo.done && <span className="due">{t("todo.planned", { date: todo.plannedOn.slice(5) })}</span>}
          {todo.changedBy && <span className="by" title={new Date(todo.changedBy.at).toLocaleString()}>{t(BY[todo.changedBy.kind] ?? "todo.by.changed")}</span>}
        </span>
      </div>
      <button type="button" className={confirming ? "remove confirming" : "remove"} disabled={busy} onClick={remove}
        aria-label={t(confirming ? "todo.confirmDelete" : "todo.delete", { title: todo.title })}>
        {confirming ? t("todo.confirm") : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>}
      </button>
    </li>
  );
}

const byDue = (a: Item, b: Item) => (a.due ?? "9999").localeCompare(b.due ?? "9999");

/** The todo page: what is open, by when it is due, filterable by area. */
export function Todos({ snapshot, fresh, areas }: { snapshot: TodoSnapshot; fresh: ReadonlySet<string>; areas: Area[] }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [newArea, setNewArea] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const { today, todos } = snapshot;

  const open = todos.filter((todo) => !todo.done);
  const shown = (todo: Item) => filter === "all" || (filter === "none" ? !todo.area : todo.area === filter);
  const chips = useMemo(() => {
    const used = areas.filter((area) => open.some((todo) => todo.area === area.id) || filter === area.id);
    return [
      { id: "all", label: t("common.all"), k: undefined as string | undefined, count: open.length },
      ...used.map((area) => ({ id: area.id, label: area.name[getLocale()], k: area.k, count: open.filter((todo) => todo.area === area.id).length })),
      ...(open.some((todo) => !todo.area) && used.length ? [{ id: "none", label: t("todo.noAreaChip"), k: "gray", count: open.filter((todo) => !todo.area).length }] : []),
    ];
  }, [areas, open, filter, getLocale()]);

  const groups = GROUPS.map(([group, label]) => [group, label, open.filter((todo) => shown(todo) && groupOf(todo, today) === group).sort(byDue)] as const);
  const done = todos.filter((todo) => todo.done && shown(todo)).sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "")).slice(0, 30);
  const visibleOpen = open.filter(shown).length;

  // New todos go into the area being looked at.
  useEffect(() => { setNewArea(areas.some((area) => area.id === filter) ? filter : ""); }, [filter, areas]);

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || adding) return;
    setAdding(true);
    setError(null);
    api.op("todo.add", { title: title.trim(), ...(due ? { due } : {}), ...(newArea ? { area: newArea } : {}) })
      .then(() => { setTitle(""); setDue(""); })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setAdding(false));
  };
  const addArea = areas.find((area) => area.id === newArea);

  return (
    <section className="todos" aria-label={t("todo.label")}>
      <header className="panel-head">
        <h2>{t("todo.label")}</h2>
        <span className="count">{open.length}</span>
      </header>
      {chips.length > 1 && (
        <div className="chips" role="group" aria-label={t("todo.byArea")}>
          {chips.map((chip) => (
            <button type="button" key={chip.id} className="chip" aria-pressed={filter === chip.id} onClick={() => setFilter(chip.id)}>
              {chip.k && <span className="mark" data-k={chip.k} />}{chip.label}<span className="count">{chip.count}</span>
            </button>
          ))}
        </div>
      )}
      <form className="todo-add" onSubmit={add}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("todo.placeholder")} aria-label={t("todo.new")} maxLength={500} />
        <input type="date" value={due} onChange={(event) => setDue(event.target.value)} aria-label={t("todo.due")} />
        <select className="tag area-pick" data-k={addArea?.k} data-empty={addArea ? undefined : true} value={newArea} onChange={(event) => setNewArea(event.target.value)} aria-label={t("todo.newArea")}>
          <option value="">{t("todo.noArea")}</option>
          {areas.map((area) => <option key={area.id} value={area.id}>{area.name[getLocale()]}</option>)}
        </select>
        <button type="submit" disabled={!title.trim() || adding}>{t("todo.add")}</button>
      </form>
      {error && <p className="problem small" role="alert">{error}</p>}
      <div className="todo-groups">
        {visibleOpen === 0 && <p className="quiet empty-list">{t(filter === "all" ? "todo.emptyAll" : "todo.emptyArea")}</p>}
        {groups.map(([group, label, items]) => items.length > 0 && (
          <div className="todo-group" key={group} data-group={group}>
            <h3>{t(label)}<span className="count">{items.length}</span></h3>
            <ul>{items.map((todo) => <TodoRow key={todo.id} todo={todo} today={today} areas={areas} fresh={fresh.has(`todo:${todo.id}`)} onError={setError} />)}</ul>
          </div>
        ))}
        {done.length > 0 && (
          <div className="todo-group">
            <button type="button" className="disclosure" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              {t("todo.done")} <span className="count">{done.length}</span>
            </button>
            {showDone && <ul>{done.map((todo) => <TodoRow key={todo.id} todo={todo} today={today} areas={areas} fresh={fresh.has(`todo:${todo.id}`)} onError={setError} />)}</ul>}
          </div>
        )}
      </div>
    </section>
  );
}
