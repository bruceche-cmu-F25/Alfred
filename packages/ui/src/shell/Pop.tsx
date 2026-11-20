/** A card in the middle of the window, the page blurred behind it; Escape or a click beside it puts it away. */
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Pop({ onClose, children }: { onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const escape = (press: KeyboardEvent) => { if (press.key === "Escape" && !press.isComposing) onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });
  return createPortal(
    <div className="ev-pop" role="presentation" onMouseDown={(down) => { if (down.target === down.currentTarget) onClose(); }}>{children}</div>,
    document.body,
  );
}
