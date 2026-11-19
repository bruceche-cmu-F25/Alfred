import { useEffect, useRef } from "react";
import { createFigure, type Figure as Live, type FigureState } from "../entity/tesseract.js";

const isDark = () => document.documentElement.dataset.scheme === "dark";

/** Alfred's figure at a given size. Its far lines fade toward whatever it sits on, and it follows light and dark. */
export function Figure({ state, size, className }: { state: FigureState; size: number; className?: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const live = useRef<Live | null>(null);

  useEffect(() => {
    if (!svg.current) return;
    // Thicker lines at small sizes; below 48 px the tesseract drops the edges joining its two cubes.
    const figure = createFigure(svg.current, { width: size >= 100 ? 4 : size >= 48 ? 4.6 : 5.6, small: size < 48, dark: isDark() });
    live.current = figure;
    const scheme = new MutationObserver(() => figure.setDark(isDark()));
    scheme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme"] });
    return () => { scheme.disconnect(); figure.destroy(); live.current = null; };
  }, [size]);

  useEffect(() => { live.current?.setState(state); }, [state]);
  // Moving between places (panel, floating button) changes what it sits on.
  useEffect(() => { live.current?.refresh(); });

  return <svg ref={svg} className={className ? `figure ${className}` : "figure"} viewBox="0 0 120 120" style={{ width: size, height: size }} aria-hidden="true" />;
}
