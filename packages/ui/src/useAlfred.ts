/** One live view of the world: the state snapshot, refreshed whenever the
 * event stream says something changed, plus what runs are writing right now.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreEvent, LiveUpdate, StateResponse } from "@alfred/protocol";
import { api, subscribe, type Connection } from "./api.ts";

export interface Alfred {
  state: StateResponse | null;
  connection: Connection;
  error: string | null;
  /** Subjects (like `todo:abc`) that Alfred changed in the last few seconds. */
  fresh: ReadonlySet<string>;
  /** Replies being written, by run id. Dropped when the run's record arrives. */
  live: Readonly<Record<string, string>>;
  /** Listen to every recorded event as it arrives. */
  onEvent(listener: (event: CoreEvent) => void): () => void;
  refresh(): void;
}

export function useAlfred(): Alfred {
  const [state, setState] = useState<StateResponse | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [live, setLive] = useState<Record<string, string>>({});
  const listeners = useRef(new Set<(event: CoreEvent) => void>());
  const pending = useRef<number | null>(null);

  const refresh = useCallback(() => {
    api.state().then((next) => { setState(next); setError(null); }).catch((reason: Error) => setError(reason.message));
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = window.setTimeout(() => { pending.current = null; refresh(); }, 120);
  }, [refresh]);

  const onEvent = useCallback((listener: (event: CoreEvent) => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  const received = useCallback((event: CoreEvent) => {
    if (event.actor === "alfred" && event.subject && !event.kind.startsWith("run.")) {
      const subject = event.subject;
      setFresh((current) => new Set(current).add(subject));
      window.setTimeout(() => setFresh((current) => { const next = new Set(current); next.delete(subject); return next; }), 2400);
    }
    if (event.runId && ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.kind)) {
      const runId = event.runId;
      setLive((current) => { if (!(runId in current)) return current; const next = { ...current }; delete next[runId]; return next; });
    }
    for (const listener of listeners.current) listener(event);
    scheduleRefresh();
  }, [scheduleRefresh]);

  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    api.state().then((initial) => {
      if (cancelled) return;
      setState(initial);
      unsubscribe = subscribe(initial.cursor, {
        event: received,
        live: (update: LiveUpdate) => setLive((current) => ({ ...current, [update.runId]: update.text })),
        connection: (next) => {
          setConnection(next);
          // After a drop, the stream replays what was missed; the snapshot catches up too.
          if (next === "live") scheduleRefresh();
        },
      });
    }).catch((reason: Error) => setError(reason.message));
    return () => { cancelled = true; unsubscribe(); };
  }, [received, scheduleRefresh]);

  return { state, connection, error, fresh, live, onEvent, refresh };
}
