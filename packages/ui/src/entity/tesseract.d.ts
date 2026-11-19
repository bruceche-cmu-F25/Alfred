export type FigureState = "rest" | "hello" | "listen" | "think" | "speak" | "work" | "notice" | "done" | "error" | "sleep";

export const STATES: FigureState[];
export const LOUD: FigureState[];
export const PALETTES: Record<"light" | "dark", Record<"ind" | "light" | "amber" | "ok" | "now", string>>;

export interface FigureOptions {
  state?: FigureState;
  /** Stroke width in the 120 × 120 box: about 4 at 100 px and up, 5.5 at 36 px, 7 at 18 px. */
  width?: number;
  /** Menu-bar style: currentColor except notice / done / error, no depth shading. */
  mono?: boolean;
  /** Drop the tesseract's W edges, for small sizes. */
  small?: boolean;
  dark?: boolean;
  /** "auto" reads the nearest ancestor's background; a CSS colour; or null for no depth shading. */
  background?: "auto" | string | null;
}

export interface Figure {
  readonly state: FigureState;
  setState(state: FigureState): void;
  setDark(dark: boolean): void;
  refresh(): void;
  destroy(): void;
}

/** Animates Alfred's figure in an <svg viewBox="0 0 120 120">. */
export function createFigure(svg: SVGSVGElement, options?: FigureOptions): Figure;

/** Draws the static mark into an <svg viewBox="0 0 120 120">. */
export function drawMark(svg: SVGSVGElement, options?: { width?: number; dark?: boolean; background?: "auto" | string | null; mono?: boolean }): void;

/** The resting mark as segments in a 120 × 120 box: [start, end, nearness 0..1]. Pure; safe in Node. */
export function markSegments(options?: { mono?: boolean }): [[number, number], [number, number], number][];
