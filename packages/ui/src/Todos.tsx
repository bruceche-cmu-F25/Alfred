import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Area } from "@alfred/protocol";
import type { TodoSnapshot } from "@alfred/module-todo/types";
import { api } from "./api.ts";

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

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function dueLabel(todo: Item, today: string): string | null {
  if (!todo.due) return null;
  if (todo.startDate && todo.startDate !== todo.due) return `${todo.startDate.slice(5)} – ${todo.due.slice(5)}`;
  if (todo.due === today) return "今天";
  if (todo.due === addDays(today, 1)) return "明天";
  if (todo.due < today) return `逾期 · ${todo.due.slice(5)}`;
  if (todo.due <= weekEnd(today)) { const [y, m, d] = todo.due.split("-").map(Number); return WEEKDAY[new Date(y, m - 1, d).getDay()]; }
  return todo.due.slice(5);
}

/** Where a todo sits on the page. Ranges running today count as today. */
type Group = "late" | "today" | "tomorrow" | "week" | "later" | "someday";
const GROUPS: Array<[Group, string]> = [["late", "逾期"], ["today", "今天"], ["tomorrow", "明天"], ["week", "本周"], ["later", "之后"], ["someday", "以后再说"]];
function groupOf(todo: Item, today: string): Group {
  if (!todo.due) return "someday";
  if (todo.startDate && todo.startDate <= today && todo.due >= today) return "today";
  if (todo.due < today) return "late";
  if (todo.due === today) return "today";
  if (todo.due === addDays(today, 1)) return "tomorrow";
  return todo.due <= weekEnd(today) ? "week" : "later";
}

const BY: Record<string, string> = { "todo.added": "Alfred 加的", "todo.completed": "Alfred 完成的" };

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
        aria-label={todo.done ? `把「${todo.title}」标回未完成` : `完成「${todo.title}」`}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.5l3 3 6-7" /></svg>
      </button>
      <div className="todo-body">
        {todo.url ? <a className="todo-title" href={todo.url} target="_blank" rel="noreferrer noopener">{todo.title}</a> : <span className="todo-title">{todo.title}</span>}
        <span className="todo-meta">
          <select className="tag area-pick" data-k={area?.k} data-empty={area ? undefined : true} value={todo.area ?? ""} disabled={busy}
            onChange={(event) => setArea(event.target.value)} aria-label={`「${todo.title}」的领域`}>
            <option value="">{area ? "不分领域" : "＋ 领域"}</option>
            {areas.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
          {todo.status === "doing" && !todo.done && <span className="tag" data-k="alfred">进行中</span>}
          {due && <span className={overdue ? "due overdue" : "due"}>{due}</span>}
          {todo.plannedOn && !todo.done && <span className="due">计划 {todo.plannedOn.slice(5)}</span>}
          {todo.changedBy && <span className="by" title={new Date(todo.changedBy.at).toLocaleString()}>{BY[todo.changedBy.kind] ?? "Alfred 改的"}</span>}
        </span>
      </div>
      <button type="button" className={confirming ? "remove confirming" : "remove"} disabled={busy} onClick={remove}
        aria-label={confirming ? `确认永久删除「${todo.title}」` : `删除「${todo.title}」`}>
        {confirming ? "确认删除" : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>}
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
      { id: "all", label: "全部", k: undefined as string | undefined, count: open.length },
      ...used.map((area) => ({ id: area.id, label: area.name, k: area.k, count: open.filter((todo) => todo.area === area.id).length })),
      ...(open.some((todo) => !todo.area) && used.length ? [{ id: "none", label: "没分领域", k: "gray", count: open.filter((todo) => !todo.area).length }] : []),
    ];
  }, [areas, open, filter]);

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
    <section className="todos" aria-label="待办">
      <header className="panel-head">
        <h2>待办</h2>
        <span className="count">{open.length}</span>
      </header>
      {chips.length > 1 && (
        <div className="chips" role="group" aria-label="按领域看">
          {chips.map((chip) => (
            <button type="button" key={chip.id} className="chip" aria-pressed={filter === chip.id} onClick={() => setFilter(chip.id)}>
              {chip.k && <span className="mark" data-k={chip.k} />}{chip.label}<span className="count">{chip.count}</span>
            </button>
          ))}
        </div>
      )}
      <form className="todo-add" onSubmit={add}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="加一件事，回车。比如：周五前把发票寄出去" aria-label="新待办" maxLength={500} />
        <input type="date" value={due} onChange={(event) => setDue(event.target.value)} aria-label="截止日" />
        <select className="tag area-pick" data-k={addArea?.k} data-empty={addArea ? undefined : true} value={newArea} onChange={(event) => setNewArea(event.target.value)} aria-label="新待办的领域">
          <option value="">不分领域</option>
          {areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
        </select>
        <button type="submit" disabled={!title.trim() || adding}>添加</button>
      </form>
      {error && <p className="problem small" role="alert">{error}</p>}
      <div className="todo-groups">
        {visibleOpen === 0 && <p className="quiet empty-list">{filter === "all" ? "没有未完成的待办。" : "这个领域没有未完成的待办。"}</p>}
        {groups.map(([group, label, items]) => items.length > 0 && (
          <div className="todo-group" key={group} data-group={group}>
            <h3>{label}<span className="count">{items.length}</span></h3>
            <ul>{items.map((todo) => <TodoRow key={todo.id} todo={todo} today={today} areas={areas} fresh={fresh.has(`todo:${todo.id}`)} onError={setError} />)}</ul>
          </div>
        ))}
        {done.length > 0 && (
          <div className="todo-group">
            <button type="button" className="disclosure" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              已完成 <span className="count">{done.length}</span>
            </button>
            {showDone && <ul>{done.map((todo) => <TodoRow key={todo.id} todo={todo} today={today} areas={areas} fresh={fresh.has(`todo:${todo.id}`)} onError={setError} />)}</ul>}
          </div>
        )}
      </div>
    </section>
  );
}
