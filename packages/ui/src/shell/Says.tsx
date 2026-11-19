/** Alfred telling the user something inside the app: the figure that is on screen (the panel's, the floating
 * button's, the phone's dock) hops, and the card comes out of it with its tail pointing back. With no figure in sight
 * (a bare page with the panel closed), a small Alfred comes up in the corner to say it and goes away after.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { FigureState } from "../entity/tesseract.js";
import { SpeechCard, type Tail } from "../speech/SpeechCard.tsx";
import { useSpeech, type Outcome, type Said } from "../speech/useSpeech.ts";
import { Figure } from "./Figure.tsx";

interface Props<T> {
  items: readonly T[];
  id(item: T): string;
  lines(item: T): Said;
  stayMs(item: T): number;
  done(item: T, outcome: Outcome): void;
  remove(item: T): void;
  /** The figure's state while it talks, for the figures the app draws; null when it is quiet. */
  onMood(mood: FigureState | null): void;
}

interface Placement { top: number; left: number; tail: Tail; tailAt: number }

/** The figure in sight to speak from: the first one laid out on screen. */
function findAnchor(): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>("[data-alfred-anchor]")) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) return element;
  }
  return null;
}

/** Below the figure when it is in the top half, above it otherwise; starting near it and kept on screen. */
function placeCard(anchor: DOMRect, card: { width: number; height: number }): Placement {
  const below = anchor.top + anchor.height / 2 < innerHeight / 2;
  const centre = anchor.left + anchor.width / 2;
  const left = Math.max(12, Math.min(innerWidth - card.width - 12, centre - 30));
  const top = below ? anchor.bottom + 16 : anchor.top - 16 - card.height;
  return { top, left, tail: below ? "top" : "bottom", tailAt: Math.max(18, Math.min(card.width - 18, centre - left)) };
}

export function Says<T>({ items, id, lines, stayMs, done, remove, onMood }: Props<T>) {
  /** No figure was in sight, so Alfred came up in the corner for this. */
  const [own, setOwn] = useState(false);
  const ownRef = useRef(false);
  ownRef.current = own;
  const speech = useSpeech<T>({ items, id, lines, stayMs, done, remove, leaving: () => ownRef.current, settled: () => setOwn(false) });
  const { phase, current, said } = speech;
  const card = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  useEffect(() => { onMood(speech.mood); }, [speech.mood, onMood]);
  useEffect(() => () => onMood(null), [onMood]);

  // About to speak: find the figure to speak from, or come out in the corner.
  useEffect(() => { if (phase === "hop" && !own && !findAnchor()) setOwn(true); }, [phase, own]);

  // The figure hops and grows: its drawing carries the phase (the anchor itself stays still, to measure).
  const talking = phase === "hop" || phase === "speak" || phase === "fold" || phase === "sink";
  useEffect(() => {
    if (!talking) return;
    const target = findAnchor();
    anchor.current = target;
    const drawing = target?.firstElementChild as HTMLElement | SVGElement | null;
    if (!drawing) return;
    drawing.setAttribute("data-speaking", phase);
    if (speech.nod) drawing.setAttribute("data-nod", String(speech.nod % 2));
    return () => { drawing.removeAttribute("data-speaking"); drawing.removeAttribute("data-nod"); };
  }, [talking, phase, speech.nod, own]);

  // Keep the card by its figure as the layout moves (panels open, the window resizes).
  const shown = !!said && !!current && (phase === "speak" || phase === "fold");
  useEffect(() => {
    if (!shown) { setPlacement(null); return; }
    let frame = 0;
    let last = "";
    const measure = () => {
      const target = anchor.current?.isConnected ? anchor.current : (anchor.current = findAnchor());
      if (target && card.current) {
        const next = placeCard(target.getBoundingClientRect(), { width: card.current.offsetWidth, height: card.current.offsetHeight });
        const key = `${next.top}|${next.left}|${next.tail}|${next.tailAt}`;
        if (key !== last) { last = key; setPlacement(next); }
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  return (
    <>
      {own && (phase !== "idle") && (
        <div className="says-own" data-phase={phase}>
          <Figure state={speech.mood ?? "rest"} size={40} anchor />
        </div>
      )}
      {shown && (
        <div ref={card} className="says" style={{ top: placement?.top ?? -9999, left: placement?.left ?? 0, visibility: placement ? undefined : "hidden" } as CSSProperties}>
          {placement && (
            <SpeechCard
              key={id(current)} said={said} out={speech.out} complete={speech.complete} folding={phase === "fold"} more={items.length - 1}
              tail={placement.tail} tailAt={`${placement.tailAt}px`}
              onOpen={() => speech.finish("open")} onNext={() => speech.finish("dismiss")} onClose={() => speech.finish("dismiss")}
              onHover={speech.setHovered}
            />
          )}
          {/* Measured before it is placed, so the first frame is already in the right spot. */}
          {!placement && <SpeechCard said={said} out={0} complete={false} folding={false} more={items.length - 1} tail="top" tailAt="0px" onOpen={() => {}} onNext={() => {}} onClose={() => {}} onHover={() => {}} />}
        </div>
      )}
    </>
  );
}
