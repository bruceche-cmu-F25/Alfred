/** Alfred telling the user things, one at a time: the figure hops, a card comes out of it and its words are typed
 * as it speaks, then the card folds back in. Shared by the Mac app's figure window and the app's own pages.
 *
 *   idle → hop → speak ⇄ fold → next → (speak | idle | sink → idle)
 *
 * Timings match speech.css.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FigureState } from "../entity/tesseract.js";

export const HOP_MS = 380;
export const FOLD_MS = 240;
export const SINK_MS = 520;
const TYPE_TICK_MS = 26;
const TYPE_TICKS = 46;

export type Phase = "idle" | "hop" | "speak" | "fold" | "next" | "sink";
/** How a card left: clicked through, closed, or it timed out unanswered. */
export type Outcome = "open" | "dismiss" | "timeout";

/** What Alfred says about one thing. */
export interface Said { title: string; body: string; mood: FigureState; action: string }

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Reveals `text` a few characters at a time, as if spoken. Returns how much is out, and whether it is all out. */
function useSpoken(text: string, key: string | null): [number, boolean] {
  const length = Array.from(text).length;
  const [out, setOut] = useState(length);
  useEffect(() => {
    if (!key || reducedMotion()) { setOut(length); return; }
    setOut(0);
    const step = Math.max(1, Math.ceil(length / TYPE_TICKS));
    const timer = window.setInterval(() => setOut((now) => {
      const next = Math.min(length, now + step);
      if (next >= length) window.clearInterval(timer);
      return next;
    }), TYPE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [key, length]);
  return [out, out >= length];
}

export interface SpeechOptions<T> {
  /** What waits to be said, first one next. The caller owns it and removes items in `remove`. */
  items: readonly T[];
  id(item: T): string;
  lines(item: T): Said;
  /** How long a card stays once fully said (never while the pointer is on it). */
  stayMs(item: T): number;
  /** As the card starts to fold: act on the outcome (open something, acknowledge). */
  done(item: T, outcome: Outcome): void;
  /** Once it has folded: take the item out of `items`. */
  remove(item: T): void;
  /** Nothing left to say: whether the figure goes away (sinks) rather than staying. */
  leaving?(): boolean;
  /** After sinking. */
  settled?(): void;
}

export interface Speech<T> {
  current: T | null;
  said: Said | null;
  phase: Phase;
  /** Characters of the body out so far, and whether all are. */
  out: number;
  complete: boolean;
  /** The figure's state while it talks (null when it is not talking). */
  mood: FigureState | null;
  /** Counts the moves to a next card, for a small nod between them. */
  nod: number;
  finish(outcome: Outcome): void;
  setHovered(hovered: boolean): void;
}

export function useSpeech<T>(options: SpeechOptions<T>): Speech<T> {
  const opts = useRef(options);
  opts.current = options;
  const [phase, setPhase] = useState<Phase>("idle");
  const [hovered, setHovered] = useState(false);
  const [nod, setNod] = useState(0);
  const current = options.items[0] ?? null;
  const said = current ? options.lines(current) : null;
  const key = current ? options.id(current) : null;
  const [out, complete] = useSpoken(said?.body ?? "", phase === "speak" ? key : null);

  // Something to say and nothing on screen: hop up, then speak.
  useEffect(() => { if (current && phase === "idle") setPhase("hop"); }, [current, phase]);
  useEffect(() => {
    if (phase !== "hop") return;
    const timer = window.setTimeout(() => setPhase("speak"), reducedMotion() ? 0 : HOP_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);
  // Taken away from under the card (e.g. its conversation was opened): move on.
  useEffect(() => { if (phase === "speak" && !current) setPhase("next"); }, [phase, current]);

  const finish = useCallback((outcome: Outcome) => {
    if (!current || phase !== "speak") return;
    const item = current;
    opts.current.done(item, outcome);
    setPhase("fold");
    window.setTimeout(() => {
      opts.current.remove(item);
      setNod((n) => n + 1);
      setPhase("next");
    }, reducedMotion() ? 0 : FOLD_MS);
  }, [current, phase]);

  // After a card folds: the next one, or rest (or go away, when the figure only came out to say these).
  useEffect(() => {
    if (phase !== "next") return;
    if (current) { setPhase("speak"); return; }
    setHovered(false);
    setPhase(opts.current.leaving?.() ? "sink" : "idle");
  }, [phase, current]);
  useEffect(() => {
    if (phase !== "sink") return;
    if (current) { setPhase("hop"); return; } // something new while going away: come straight back
    const timer = window.setTimeout(() => { setPhase("idle"); opts.current.settled?.(); }, reducedMotion() ? 0 : SINK_MS);
    return () => window.clearTimeout(timer);
  }, [phase, current]);

  // Once fully said, the card stays a while; never while the pointer is on it.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    if (!current || phase !== "speak" || !complete || hovered) return;
    const timer = window.setTimeout(() => finishRef.current("timeout"), opts.current.stayMs(current));
    return () => window.clearTimeout(timer);
  }, [current, phase, complete, hovered]);

  const talking = phase === "hop" || phase === "speak" || phase === "fold";
  const mood: FigureState | null = talking && said ? (phase === "speak" && !complete ? "speak" : said.mood) : null;
  return { current, said, phase, out, complete, mood, nod, finish, setHovered };
}
