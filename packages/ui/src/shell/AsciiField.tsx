/** The Code page's backdrop: a slow field of characters, so the place where code is written does not look like the
 * everyday pages. Drawn on a canvas about ten times a second, which is also what makes it read as text and not as
 * video. Still when the user asks for less motion, stopped while the window is hidden. Decoration only: it takes no
 * input and is hidden from assistive tech. Its colours come from CSS (`color`, and `outline-color` for Alfred's).
 */
import { useEffect, useRef } from "react";

const CELL_W = 11, CELL_H = 20;
const FRAME_MS = 100;
/** From almost nothing to dense. Light marks only: it is a texture, not a picture. */
const RAMP = "..::-=+*";
/** Now and then, where the field is densest, something that looks like code. */
const CODE = "{}<>/;()=[]";
/** Below this the cell is empty: most of the field is. */
const FLOOR = .5;

/** A number in [0, 1) that is always the same for the same cell and moment. */
const chance = (x: number, y: number, n: number) => { const v = Math.sin(x * 127.1 + y * 311.7 + n * 74.7) * 43758.5453; return v - Math.floor(v); };

/** How dense the field is at a cell, 0 to 1: a few slow waves crossing at a slant (none along the rows, which would
 * read as ruled lines), and rings around a point off to one side. */
function density(x: number, y: number, t: number, cols: number, rows: number): number {
  const rings = Math.hypot((x - cols * .72) * .55, y - rows * .38);
  const v = Math.sin(x * .07 + y * .06 + t * .4) + Math.sin(y * .15 - x * .035 - t * .3) + Math.sin((x * .5 - y) * .09 + t * .22) + Math.sin(rings * .18 - t * .5);
  return (v + 4) / 8;
}

export function AsciiField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let width = 0, height = 0, frame = 0, last = 0, ink = "", alfred = "", read = 0;
    const still = matchMedia("(prefers-reduced-motion: reduce)");

    const draw = (now: number) => {
      // The scheme can change under it: look the colours up again once a second.
      if (now - read > 1000 || !ink) { const style = getComputedStyle(canvas); ink = style.color; alfred = style.outlineColor; read = now; }
      const t = now / 1000;
      const cols = Math.ceil(width / CELL_W), rows = Math.ceil(height / CELL_H);
      const beat = Math.floor(t / 2.5);
      context.clearRect(0, 0, width, height);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const level = (density(x, y, t, cols, rows) - FLOOR) / (1 - FLOOR);
          if (level <= 0) continue;
          const code = level > .45 && chance(x, y, beat) > .93;
          context.fillStyle = code ? alfred : ink;
          context.globalAlpha = code ? .85 : .3 + level * .5;
          context.fillText(code ? CODE[Math.floor(chance(y, x, beat) * CODE.length)] : RAMP[Math.min(RAMP.length - 1, Math.floor(level * RAMP.length))],
            x * CELL_W + CELL_W / 2, y * CELL_H + CELL_H / 2);
        }
      }
    };
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      draw(now);
    };
    const start = () => { cancelAnimationFrame(frame); if (still.matches || document.hidden) draw(performance.now()); else frame = requestAnimationFrame(tick); };
    const size = () => {
      const ratio = Math.min(2, devicePixelRatio || 1);
      width = canvas.clientWidth; height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      context.textAlign = "center"; context.textBaseline = "middle";
      draw(performance.now());
    };
    const sizes = new ResizeObserver(size);
    sizes.observe(canvas);
    still.addEventListener("change", start);
    document.addEventListener("visibilitychange", start);
    start();
    return () => { cancelAnimationFrame(frame); sizes.disconnect(); still.removeEventListener("change", start); document.removeEventListener("visibilitychange", start); };
  }, []);
  return <canvas ref={ref} className="ascii" aria-hidden="true" />;
}
