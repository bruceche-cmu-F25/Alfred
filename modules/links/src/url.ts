/** Addresses: tidying one, finding one in a line of text, and telling what kind of thing it points at.
 * Pure (no Node), so a device can use the same rules to say what a pasted address will become. */
import type { LinkType } from "./types.ts";

/** Query parameters that only say where a link was shared from. Anything else is kept: some sites need theirs. */
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|igshid|mc_cid|mc_eid|spm|spm_id_from|vd_source|share_source|share_medium|share_plat|share_session_id|share_tag|share_from|from_source|feature|si|ref_src|ref_url)$/i;

export class LinkUrlError extends Error {
  override name = "LinkUrlError";
}

/** The first web address in a line of text (a share sheet's "Title https://… open in the app"), and the rest. */
export function findUrl(text: string): { url: string; rest: string } | null {
  const match = /https?:\/\/[^\s<>"'，。；、）】]+/i.exec(text);
  if (match) {
    const url = match[0].replace(/[.,;:!?)\]]+$/, "");
    const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/\s+/g, " ").replace(/ ([，。；、,;:：])/g, "$1").trim();
    return { url, rest };
  }
  // A bare host typed by hand: "github.com/owner/repo".
  const bare = /^\s*((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?)\s*$/i.exec(text);
  return bare ? { url: `https://${bare[1]}`, rest: "" } : null;
}

/** An address as it is kept: http or https only, host in lower case, no fragment, no share-tracking parameters, and
 * one form per YouTube video. Two ways of writing one page are then one link. Throws LinkUrlError. */
export function normalizeUrl(input: string): string {
  const text = input.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`); } catch { throw new LinkUrlError("That is not a web address"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new LinkUrlError("Only http and https addresses can be saved");
  if (!url.hostname.includes(".") || url.username || url.password) throw new LinkUrlError("That is not a public web address");
  if (text.length > 2000) throw new LinkUrlError("That address is too long");
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  const host = url.hostname.replace(/^(www|m)\./, "");
  // One form per YouTube video, keeping where to start.
  const video = host === "youtu.be" ? url.pathname.slice(1).split("/")[0]
    : host === "youtube.com" || host === "music.youtube.com" ? (url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(shorts|live|embed)\/([\w-]{11})/.exec(url.pathname)?.[2]) : null;
  if (video && /^[\w-]{11}$/.test(video)) {
    const at = url.searchParams.get("t");
    return `https://www.youtube.com/watch?v=${video}${at ? `&t=${encodeURIComponent(at)}` : ""}`;
  }
  let href = url.href;
  if (url.pathname === "/" && !url.search) href = href.replace(/\/$/, "");
  return href;
}

interface Rule { platform: string; type: LinkType; host: RegExp; path?: RegExp }
/** First match wins. A platform's catch-all comes after its more exact rules. */
const RULES: Rule[] = [
  { platform: "youtube", type: "video", host: /(^|\.)youtube\.com$|^youtu\.be$/ },
  { platform: "bilibili", type: "article", host: /(^|\.)bilibili\.com$/, path: /^\/(read|opus)\// },
  { platform: "bilibili", type: "video", host: /(^|\.)bilibili\.com$|^b23\.tv$/ },
  { platform: "xiaohongshu", type: "post", host: /(^|\.)xiaohongshu\.com$|^xhslink\.com$/ },
  { platform: "douyin", type: "video", host: /(^|\.)douyin\.com$|(^|\.)tiktok\.com$/ },
  { platform: "vimeo", type: "video", host: /(^|\.)vimeo\.com$/ },
  { platform: "github", type: "repo", host: /^github\.com$/, path: /^\/[^/]+\/[^/]+\/?$/ },
  { platform: "github", type: "doc", host: /^github\.com$|^gist\.github\.com$/ },
  { platform: "arxiv", type: "doc", host: /(^|\.)arxiv\.org$/ },
  { platform: "wechat", type: "article", host: /^mp\.weixin\.qq\.com$/ },
  { platform: "zhihu", type: "article", host: /(^|\.)zhihu\.com$/ },
  { platform: "x", type: "post", host: /^(x|twitter)\.com$/ },
  { platform: "weibo", type: "post", host: /(^|\.)weibo\.(com|cn)$/ },
  { platform: "reddit", type: "post", host: /(^|\.)reddit\.com$/ },
  { platform: "hackernews", type: "post", host: /^news\.ycombinator\.com$/ },
];

/** What an address points at, from the address alone. Anything unknown is an article on the web. */
export function classify(href: string): { platform: string; type: LinkType; host: string } {
  let url: URL;
  try { url = new URL(href); } catch { return { platform: "web", type: "article", host: "" }; }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const rule = RULES.find((candidate) => candidate.host.test(host) && (!candidate.path || candidate.path.test(url.pathname)));
  if (rule) return { platform: rule.platform, type: rule.type, host };
  return { platform: "web", type: /\.pdf$/i.test(url.pathname) ? "doc" : "article", host };
}

/** Hosts that only stand for another address: the page behind one is what gets saved. */
export const isShortener = (href: string) => { try { return /^(b23\.tv|xhslink\.com|youtu\.be|t\.co|bit\.ly|tinyurl\.com|goo\.gl|dwz\.cn)$/.test(new URL(href).hostname); } catch { return false; } };

/** A readable name from the address itself, for a page that has not been (or cannot be) asked for its title:
 * "leetcode.com/problems/two-sum" becomes "leetcode.com · two sum". */
export function nameFromUrl(href: string): string {
  let url: URL;
  try { url = new URL(href); } catch { return href; }
  const host = url.hostname.replace(/^www\./, "");
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  if (!last) return host;
  let words = last;
  try { words = decodeURIComponent(last); } catch { /* as written */ }
  words = words.replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_+]+/g, " ").trim();
  return words && words.length <= 80 && !/^[\w-]{16,}$/.test(last) ? `${host} · ${words}` : host;
}
