import { createContext, useContext, useEffect, useRef } from "react";
import { api } from "./api.ts";
import { Markdown } from "./Markdown.tsx";

export const WindowAttention = createContext(false);

/** Only seeing the finished text clears its dot, in either the conversation or the small ask card. */
export function ConversationReply({ text, conversationId, runId, unread }: {
  text: string; conversationId: string; runId: string; unread: boolean;
}) {
  const attending = useContext(WindowAttention);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = body.current;
    if (!attending || !unread || !element) return;
    let active = true;
    let sending = false;
    let retry: number | undefined;
    const observe = () => {
      if (!active) return;
      observer.unobserve(element);
      observer.observe(element);
    };
    const observer = new IntersectionObserver(([entry]) => {
      window.clearTimeout(retry);
      if (!active || sending || !entry?.isIntersecting || document.visibilityState !== "visible" || !document.hasFocus()) return;
      const rect = entry.intersectionRect;
      if (rect.width <= 0 || rect.height <= 0) return;
      // Intersection includes scroll clipping, but not a sheet or search palette sitting on top.
      const front = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!element.contains(front)) { retry = window.setTimeout(observe, 800); return; }
      sending = true;
      void api.readConversationReply(conversationId, runId).catch(() => {
        sending = false;
        if (active) retry = window.setTimeout(observe, 2500);
      });
    });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); window.clearTimeout(retry); };
  }, [attending, unread, conversationId, runId]);
  return <Markdown ref={body} className="reply-text" text={text} />;
}
