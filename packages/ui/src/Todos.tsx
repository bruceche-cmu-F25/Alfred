import { useEffect, useState, type FormEvent } from "react";
import type { TodoSnapshot } from "@alfred/module-todo/types";
import { api } from "./api.ts";

type Item = TodoSnapshot["todos"][number];

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(y, m - 1, d + days);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

function dueLabel(todo: Item, today: string): string | null {
  if (!todo.due) return null;
  if (todo.startDate && todo.startDate !== todo.due) return `${todo.startDate.slice(5)} – ${todo.due.slice(5)}`;
  if (todo.due === today) return "今天";
  if (todo.due === addDays(today, 1)) return "明天";
  if (todo.due < today) return `逾期 · ${todo.due.slice(5)}`;
  return todo.due.slice(5);
}

function TodoRow({ todo, today, fresh, onError }: { todo: Item; today: string; fresh: boolean; onError: (message: string) => void }) {
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
  const due = dueLabel(todo, today);
  const overdue = !todo.done && !!todo.due && todo.due < today;

  return (
    <li className="todo" data-done={todo.done || undefined} data-fresh={fresh || undefined}>
      <button type="button" className="check" role="checkbox" aria-checked={todo.done} disabled={busy} onClick={toggle}
        aria-label={todo.done ? `把「${todo.title}」标回未完成` : `完成「${todo.title}」`}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.5l3 3 6-7" /></svg>
      </button>
      <div className="todo-body">
        {todo.url ? <a href={todo.url} target="_blank" rel="noreferrer noopener">{todo.title}</a> : <span>{todo.title}</span>}
        <span className="todo-meta">
          {todo.status === "doing" && !todo.done && <span className="tag">进行中</span>}
          {due && <span className={overdue ? "due overdue" : "due"}>{due}</span>}
          {todo.plannedOn && !todo.done && <span className="due">计划 {todo.plannedOn.slice(5)}</span>}
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

export function Todos({ snapshot, fresh }: { snapshot: TodoSnapshot; fresh: ReadonlySet<string> }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const { today, todos } = snapshot;

  const open = todos.filter((todo) => !todo.done);
  const groups: Array<[string, Item[]]> = [
    ["逾期", open.filter((todo) => todo.due && todo.due < today).sort(byDue)],
    ["今天", open.filter((todo) => todo.due === today || (todo.startDate && todo.startDate <= today && todo.due && todo.due > today))],
    ["之后", open.filter((todo) => todo.due && todo.due > today && !(todo.startDate && todo.startDate <= today)).sort(byDue)],
    ["没有日期", open.filter((todo) => !todo.due)],
  ];
  const done = todos.filter((todo) => todo.done).sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "")).slice(0, 30);

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || adding) return;
    setAdding(true);
    setError(null);
    api.op("todo.add", { title: title.trim(), ...(due ? { due } : {}) })
      .then(() => { setTitle(""); setDue(""); })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setAdding(false));
  };

  return (
    <section className="todos" aria-label="待办">
      <header className="panel-head">
        <h2>待办</h2>
        <span className="count">{open.length}</span>
      </header>
      <form className="todo-add" onSubmit={add}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="加一条…" aria-label="新待办" maxLength={500} />
        <input type="date" value={due} onChange={(event) => setDue(event.target.value)} aria-label="截止日" />
        <button type="submit" disabled={!title.trim() || adding}>添加</button>
      </form>
      {error && <p className="problem small" role="alert">{error}</p>}
      <div className="todo-groups">
        {open.length === 0 && <p className="quiet empty-list">没有未完成的待办。</p>}
        {groups.map(([label, items]) => items.length > 0 && (
          <div className="todo-group" key={label}>
            <h3>{label}</h3>
            <ul>{items.map((todo) => <TodoRow key={todo.id} todo={todo} today={today} fresh={fresh.has(`todo:${todo.id}`)} onError={setError} />)}</ul>
          </div>
        ))}
        {done.length > 0 && (
          <div className="todo-group">
            <button type="button" className="disclosure" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              已完成 <span className="count">{done.length}</span>
            </button>
            {showDone && <ul>{done.map((todo) => <TodoRow key={todo.id} todo={todo} today={today} fresh={fresh.has(`todo:${todo.id}`)} onError={setError} />)}</ul>}
          </div>
        )}
      </div>
    </section>
  );
}
