/** Keeps the todo list in step with the calendar (the todo module's `mirrorCalendar`): after the calendar has been
 * read and something in it changed, after the user changes which events become todos, after a todo is finished, at
 * start, and now and then (the two weeks it looks ahead move with the day).
 *
 * This is the one place that knows both modules. Neither reads the other's tables: the calendar's events are taken
 * from its snapshot, as a device would get them, and handed to the todo module as plain data.
 */
import type { World } from "@alfred/core";
import type { AlfredModule } from "@alfred/module-kit";
import type { CalendarSnapshot } from "@alfred/module-calendar";
import { getTodoSettings, mirrorCalendar } from "@alfred/module-todo";

const EVERY_MS = 60 * 60_000;

export function watchTodoSources(world: World, calendar: AlfredModule, log?: (message: string) => void): () => void {
  let cursor = 0;
  let timer: NodeJS.Timeout | null = null;
  let mirroring = false;
  const mirror = () => {
    timer = null;
    if (!world.db.isOpen) return;
    mirroring = true;
    try {
      cursor = Number(world.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM core_events").get()!.seq);
      const mode = getTodoSettings(world).fromCalendar;
      if (mode === "off") return;
      const snapshot = calendar.snapshot!(world) as CalendarSnapshot;
      const healthy = new Set(snapshot.sources.filter((source) => !source.error && source.syncedAt).map((source) => source.account));
      const done = mirrorCalendar(world, snapshot.events, { today: snapshot.today, healthy, mode });
      if (done.added || done.updated || done.removed) log?.(`todos from the calendar: ${done.added} added, ${done.updated} changed, ${done.removed} removed`);
    } catch (error) {
      log?.(`todos from the calendar: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      mirroring = false;
      // What it changed itself is not news to it.
      if (world.db.isOpen) cursor = Number(world.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM core_events").get()!.seq);
    }
  };
  const soon = (ms: number) => { if (!timer) { timer = setTimeout(mirror, ms); timer.unref(); } };
  const off = world.onCommit(() => {
    if (timer || mirroring || !world.db.isOpen) return;
    // Only what the mirror depends on: the calendar as read, the user's choice of events, and a todo finished
    // or changed (if it was one time of what repeats weekly, the next time takes its place).
    const news = world.db.prepare("SELECT 1 FROM core_events WHERE seq > ? AND kind IN ('calendar.synced', 'todo.sources_set', 'todo.completed', 'todo.updated') LIMIT 1").get(cursor);
    if (news) soon(300);
  });
  soon(3000);
  const every = setInterval(() => soon(0), EVERY_MS);
  every.unref();
  return () => { off(); clearInterval(every); if (timer) clearTimeout(timer); };
}
