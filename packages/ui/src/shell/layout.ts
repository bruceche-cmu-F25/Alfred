/** The workspace's arrangement: sidebar full or folded to icons, its width, and Alfred's panel (beside the page,
 * across the whole page, or closed to a floating button). Remembered per device in localStorage, which may be
 * unavailable: then it simply starts from the defaults each time.
 */
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

export type NavMode = "full" | "rail";
export type AlfredMode = "open" | "wide" | "closed";
export interface Layout { nav: NavMode; navW: number; alfW: number; alfred: AlfredMode }

export const NAV = { min: 168, max: 300, def: 208, rail: 56, foldAt: 120 };
/** pageMin: what the page keeps while Alfred has width to give. pageFloor: what it keeps at any window size (a phone's width). */
export const ALF = { min: 300, max: 640, def: 400, pageMin: 420, pageFloor: 320 };
/** Below this width the workspace is a phone: one column, a dock, Alfred as a sheet. The Mac window never gets this narrow. */
export const PHONE = "(max-width: 700px)";
const KEY = "alfred.layout";
/** Raised when a default changes for every device once: 2 = Alfred's panel starts closed (2026-11-18). */
const VERSION = 2;

function load(): Layout {
  // Alfred starts closed: the page has the room, and the figure waits in the top right corner.
  const fallback: Layout = { nav: window.innerWidth < 1200 ? "rail" : "full", navW: NAV.def, alfW: ALF.def, alfred: "closed" };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as (Partial<Layout> & { v?: number }) | null;
    if (!saved) return fallback;
    return {
      nav: saved.nav === "rail" || saved.nav === "full" ? saved.nav : fallback.nav,
      navW: typeof saved.navW === "number" ? Math.min(NAV.max, Math.max(NAV.min, saved.navW)) : NAV.def,
      alfW: typeof saved.alfW === "number" ? Math.min(ALF.max, Math.max(ALF.min, saved.alfW)) : ALF.def,
      alfred: (saved.v ?? 1) < VERSION ? fallback.alfred
        : saved.alfred === "open" || saved.alfred === "wide" || saved.alfred === "closed" ? saved.alfred : fallback.alfred,
    };
  } catch {
    return fallback;
  }
}

export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useLayout(): [Layout, (patch: Partial<Layout>) => void] {
  const [layout, setLayout] = useState(load);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ ...layout, v: VERSION })); } catch { /* not remembered; fine */ }
  }, [layout]);
  const update = useCallback((patch: Partial<Layout>) => setLayout((current) => ({ ...current, ...patch })), []);
  return [layout, update];
}

/**
 * What to draw: the page never drops below ALF.pageMin unless Alfred is already at its minimum. In a window too small
 * for a full sidebar, Alfred and a page of ALF.pageFloor, the sidebar gives way: it narrows, then draws as its rail
 * (`navMode`; the remembered choice in `layout.nav` is left alone, so it comes back when there is room).
 */
export function widths(layout: Layout, viewport: number, alfredBeside = false): { nav: number; navMode: NavMode; alf: number } {
  let navMode = layout.nav;
  let nav = navMode === "rail" ? NAV.rail : layout.navW;
  if (alfredBeside && navMode === "full") {
    const spare = viewport - ALF.min - ALF.pageFloor;
    if (spare < NAV.min) { navMode = "rail"; nav = NAV.rail; }
    else nav = Math.min(nav, spare);
  }
  const room = viewport - nav - ALF.pageMin;
  return { nav, navMode, alf: Math.max(ALF.min, Math.min(layout.alfW, ALF.max, room)) };
}

export function useViewportWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

/**
 * A divider drag. `edge` says which way is wider: the sidebar grows to the right, Alfred to the left.
 * Returns pointer handlers for the divider element.
 */
export function dragHandle(start: number, edge: "right" | "left", onMove: (width: number) => void, onEnd?: () => void) {
  return (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    target.classList.add("active");
    document.body.classList.add("resizing");
    const x0 = event.clientX;
    const move = (moved: PointerEvent) => onMove(start + (edge === "right" ? moved.clientX - x0 : x0 - moved.clientX));
    const up = () => {
      target.classList.remove("active");
      document.body.classList.remove("resizing");
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      onEnd?.();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
}
