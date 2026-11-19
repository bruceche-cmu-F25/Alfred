/** Finds the web addresses in a piece of text, so a page can draw them as links (Linked.tsx). Pure: no DOM. */

/** A stretch of plain text, or an address: where it goes and how it was written. */
export type TextPart = string | { url: string; text: string };

/** An address starts at `http(s)://` or `www.` and runs to the next space, quote, angle bracket or CJK punctuation. */
const ADDRESS = /(?<![A-Za-z0-9@.])(?:https?:\/\/|www\.)[^\s<>"'`“”‘’「」『』（）【】，。；！？、]+/gi;

function webUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

export function linkParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(ADDRESS)) {
    let found = match[0];
    // What ends the sentence does not belong to the address; a closing bracket only does when its opening one is in it.
    for (;;) {
      const tail = found.at(-1) ?? "";
      const stray = ".,;:!?".includes(tail) || (tail === ")" && !found.includes("(")) || (tail === "]" && !found.includes("["));
      if (!tail || !stray) break;
      found = found.slice(0, -1);
    }
    const url = webUrl(/^www\./i.test(found) ? `https://${found}` : found);
    if (!url) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ url, text: found });
    last = match.index + found.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
