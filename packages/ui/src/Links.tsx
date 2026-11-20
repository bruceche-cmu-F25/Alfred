/** The Links page (docs/design/links.md): the places you keep going to, as a row of tiles, and what you saved from
 * the internet, as cards in one block per topic. A card says what the thing is called, where it is, why you saved
 * it and what it is filed under; opened, it shows what the page says of itself and what you can do with it.
 * L1: a saved page is looked up for its title; it is not read or summarised yet, and the card does not pretend so.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { Area } from "@alfred/protocol";
import type { Clip, ClipState, LinksSnapshot, LinkType, Place, Topic } from "@alfred/module-links/types";
import { classify, findUrl } from "@alfred/module-links/url";
import { api } from "./api.ts";
import { OutLink } from "./Linked.tsx";
import { getLocale, t, type Key } from "./i18n/index.ts";
import { when } from "./shell/Nav.tsx";
import "./links-page.css";

/** How a platform is called; anything else goes by its site. */
const PLATFORM: Record<string, string | [string, string]> = {
  youtube: "YouTube", bilibili: ["B 站", "Bilibili"], xiaohongshu: ["小红书", "RED"], github: "GitHub", arxiv: "arXiv", wechat: ["公众号", "WeChat"],
  zhihu: ["知乎", "Zhihu"], x: "X", weibo: ["微博", "Weibo"], reddit: "Reddit", hackernews: "Hacker News", douyin: ["抖音", "TikTok"], vimeo: "Vimeo",
};
const platformName = (id: string): string | undefined => { const name = PLATFORM[id]; return Array.isArray(name) ? name[getLocale() === "en" ? 1 : 0] : name; };
const TYPES: LinkType[] = ["video", "article", "post", "repo", "doc"];
/** Why a page could not be looked up, in the user's words, by the home node's short code. */
const WHY: Record<string, Key> = { login: "links.why.login", status: "links.why.status", timeout: "links.why.timeout", network: "links.why.timeout", not_html: "links.why.notPage" };
const STATES: ClipState[] = ["unread", "seen", "todo"];

const GLYPH: Record<LinkType, ReactNode> = {
  video: <path d="M7 5.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
  article: <path d="M5 6h10M5 10h10M5 14h6" />,
  post: <><rect x="4.5" y="4.5" width="11" height="11" rx="2.5" /><path d="M7.5 12.5l2-2 1.5 1.5 1.5-2" /></>,
  repo: <path d="M7.5 6L4 10l3.5 4M12.5 6L16 10l-3.5 4" />,
  doc: <path d="M6 3.5h5.5L15 7v9.5H6zM11.5 3.5V7H15M8.5 11h4M8.5 13.5h4" />,
};

/** A site's own icon, kept and served by the home node (never asked of the site from here); `fallback` until it
 * loads, and for good when there is none. */
function SiteIcon({ icon, fallback }: { icon: string | undefined; fallback: ReactNode }) {
  const [broken, setBroken] = useState(false);
  if (!icon || broken) return <>{fallback}</>;
  return <img className="lk-icon" src={`/api/modules/link/files/${encodeURIComponent(icon)}`} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />;
}

/** Runs a module operation; an `{ error }` answer is shown like a failure. */
function useOp(onError: (message: string | null) => void) {
  const [busy, setBusy] = useState(false);
  const run = (op: string, input: unknown, then?: (result: unknown) => void) => {
    setBusy(true);
    onError(null);
    return api.op(op, input).then((response) => {
      const result = response.result as { error?: string } | null;
      if (result && typeof result.error === "string") onError(result.error);
      else then?.(result);
    }).catch((reason: Error) => onError(reason.message)).finally(() => setBusy(false));
  };
  return { busy, run };
}

/** A topic chooser: the user's topics, none, or a new one named on the spot. */
function TopicPick({ topics, areas, value, disabled, label, onPick }: {
  topics: Topic[]; areas: Area[]; value: string; disabled?: boolean; label: string; onPick(choice: { topicId: string } | { topic: string }): void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  if (naming) {
    const done = () => { const next = name.trim(); setNaming(false); setName(""); if (next) onPick({ topic: next }); };
    return (
      <input className="lk-pick lk-new" autoFocus value={name} maxLength={60} placeholder={t("links.topic.name")} aria-label={t("links.topic.name")}
        onChange={(event) => setName(event.target.value)} onBlur={done}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); done(); } if (event.key === "Escape") { setNaming(false); setName(""); } }} />
    );
  }
  const areaName = (id: string | undefined) => areas.find((area) => area.id === id)?.name[getLocale()];
  return (
    <select className="lk-pick" value={value} disabled={disabled} aria-label={label}
      onChange={(event) => { if (event.target.value === "+") setNaming(true); else onPick({ topicId: event.target.value }); }}>
      <option value="">{t("links.topic.none")}</option>
      {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}{areaName(topic.area) ? ` · ${areaName(topic.area)}` : ""}</option>)}
      <option value="+">{t("links.topic.new")}</option>
    </select>
  );
}

function Card({ clip, topics, areas, open, fresh, onOpen, onError }: {
  clip: Clip; topics: Topic[]; areas: Area[]; open: boolean; fresh: boolean; onOpen(): void; onError(message: string | null): void;
}) {
  const { busy, run } = useOp(onError);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const topic = topics.find((candidate) => candidate.id === clip.topicId);
  const area = areas.find((candidate) => candidate.id === topic?.area);
  const looking = clip.fetch === "pending";
  // Where it is: the platform when it is a known one, then who or which site, then when it was saved.
  const platform = platformName(clip.platform);
  const site = platform && (clip.site === classify(clip.url).host || clip.site.toLowerCase() === clip.platform) ? undefined : clip.site;
  const where = [platform, clip.author ?? site, when(clip.savedAt)].filter(Boolean).join(" · ");
  const update = (patch: Record<string, unknown>) => run("link.update", { id: clip.id, patch });
  return (
    <li className="lk-card" data-open={open || undefined} data-fresh={fresh || undefined} data-k={area?.k ?? "gray"}>
      <button type="button" className="lk-main" onClick={onOpen} aria-expanded={open}>
        <span className="lk-cover"><svg viewBox="0 0 20 20" aria-hidden="true">{GLYPH[clip.type]}</svg></span>
        <span className="lk-text">
          <span className="lk-title" data-quiet={clip.titleSource === "url" || undefined}>{clip.title}</span>
          <span className="lk-where">{clip.icon && <SiteIcon icon={clip.icon} fallback={null} />}<span>{where}</span></span>
          {clip.note && <span className="lk-note">{clip.note}</span>}
          <span className="lk-foot">
            {topic && <span className="tag">{topic.name}</span>}
            <span className="lk-state" data-s={clip.state}><i />{t(`links.state.${clip.state}` as Key)}</span>
            {looking && <span className="lk-looking"><span className="pulse" />{t("links.looking")}</span>}
            {!looking && clip.titleSource === "url" && <span className="lk-warn">{t(clip.fetchError === "login" ? "links.walled" : "links.noTitle")}</span>}
            {clip.byAlfred && <span className="by">{t("links.byAlfred")}</span>}
          </span>
        </span>
      </button>
      {open && (
        <div className="lk-more">
          {clip.description && <p className="lk-desc"><span>{t("links.pageSays")}</span>{clip.description}</p>}
          {clip.fetch === "failed" && (
            <p className="lk-hint" data-k="warm">
              <span>{t(WHY[clip.fetchError ?? ""] ?? "links.why.other")}</span>
              <button type="button" className="lk-btn" disabled={busy} onClick={() => run("link.refetch", { id: clip.id })}>{t("links.retry")}</button>
            </p>
          )}
          <div className="lk-acts">
            <OutLink className="lk-btn solid" href={clip.url}>{t("links.open")} ↗</OutLink>
            {STATES.map((state) => (
              <button type="button" key={state} className="lk-btn" aria-pressed={clip.state === state} disabled={busy} onClick={() => update({ state })}>{t(`links.state.${state}` as Key)}</button>
            ))}
            <TopicPick topics={topics} areas={areas} value={clip.topicId ?? ""} disabled={busy} label={t("links.topic.of", { title: clip.title })} onPick={update} />
            <span className="grow" />
            <button type="button" className={confirming ? "lk-btn danger" : "lk-btn quiet"} disabled={busy}
              onClick={() => { if (!confirming) return setConfirming(true); setConfirming(false); void run("link.remove", { id: clip.id }); }}>
              {t(confirming ? "todo.confirm" : "links.remove")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** The places: tiles that open in the browser. In edit mode each can be renamed, moved or removed. */
function Places({ places, onError }: { places: Place[]; onError(message: string | null): void }) {
  const { busy, run } = useOp(onError);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const move = (index: number, by: number) => {
    const ids = places.map((place) => place.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + by, 0, id);
    void run("link.order", { ids });
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    void run("link.pin", { url: url.trim(), ...(name.trim() ? { title: name.trim() } : {}) }, () => { setUrl(""); setName(""); setAdding(false); });
  };
  // A tile's letters: one character of a Chinese name, the initials of several words, else the first two letters.
  const mark = (title: string) => {
    if (/^[\u4e00-\u9fff]/.test(title)) return title.slice(0, 1);
    const words = title.trim().split(/\s+/);
    return words.length > 1 ? words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join("") : title.slice(0, 2);
  };
  return (
    <section className="lk-band" aria-label={t("links.places")}>
      <h3>{t("links.places")}
        <button type="button" className="lk-edit" aria-pressed={editing} onClick={() => { setEditing(!editing); setAdding(false); }}>{t(editing ? "links.done" : "links.edit")}</button>
      </h3>
      <div className="lk-places" data-editing={editing || undefined}>
        {places.map((place, index) => editing ? (
          <div className="lk-place" key={place.id}>
            <span className="lk-tile" data-icon={place.icon ? true : undefined}><SiteIcon icon={place.icon} fallback={mark(place.title)} /></span>
            <input defaultValue={place.title} maxLength={60} aria-label={t("links.place.name", { title: place.title })} disabled={busy}
              onBlur={(event) => { const next = event.target.value.trim(); if (next && next !== place.title) void run("link.rename", { id: place.id, title: next }); else event.target.value = place.title; }}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
            <span className="lk-place-acts">
              <button type="button" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={t("links.place.left", { title: place.title })}>←</button>
              <button type="button" disabled={busy || index === places.length - 1} onClick={() => move(index, 1)} aria-label={t("links.place.right", { title: place.title })}>→</button>
              <button type="button" disabled={busy} onClick={() => run("link.remove", { id: place.id })} aria-label={t("links.place.remove", { title: place.title })}>×</button>
            </span>
          </div>
        ) : (
          <a className="lk-place" key={place.id} href={place.url} target="_blank" rel="noreferrer noopener" title={place.url}>
            <span className="lk-tile" data-icon={place.icon ? true : undefined}><SiteIcon icon={place.icon} fallback={mark(place.title)} /></span><span className="lk-place-name">{place.title}</span>
          </a>
        ))}
        {!editing && (
          <button type="button" className="lk-place add" onClick={() => setAdding(!adding)} aria-expanded={adding}>
            <span className="lk-tile">+</span><span className="lk-place-name">{t("links.place.add")}</span>
          </button>
        )}
      </div>
      {adding && !editing && (
        <form className="lk-add" onSubmit={add}>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t("links.place.url")} aria-label={t("links.place.url")} autoFocus spellCheck={false} maxLength={2000} />
          <input className="short" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("links.place.nameNew")} aria-label={t("links.place.nameNew")} maxLength={60} />
          <button type="submit" disabled={!url.trim() || busy}>{t("links.pin")}</button>
        </form>
      )}
    </section>
  );
}

const DAY = 86_400_000;

export function Links({ snapshot, fresh, areas }: { snapshot: LinksSnapshot | undefined; fresh: ReadonlySet<string>; areas: Area[] }) {
  const { places = [], clips = [], topics = [] } = snapshot ?? {};
  const [draft, setDraft] = useState("");
  const [pick, setPick] = useState<{ topicId: string } | { topic: string }>({ topicId: "" });
  const [type, setType] = useState<LinkType | "all">("all");
  const [only, setOnly] = useState<ClipState | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useOp(setError);

  // What a pasted line will become, said before it is saved: the address in it, and the words around it as the note.
  const found = useMemo(() => findUrl(draft), [draft]);
  const kind = found ? classify(found.url) : null;
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!found || busy) return;
    void run("link.save", { url: found.url, ...(found.rest ? { note: found.rest } : {}), ...("topic" in pick ? { topic: pick.topic } : pick.topicId ? { topicId: pick.topicId } : {}) },
      () => { setDraft(""); setPick({ topicId: "" }); });
  };

  const shown = (clip: Clip) => (type === "all" || clip.type === type) && (only === "all" || clip.state === only);
  const now = Date.now();
  const recent = clips.filter((clip) => clip.fetch === "pending" || (clip.state === "unread" && now - Date.parse(clip.savedAt) < 2 * DAY)).slice(0, 5);
  const filed = clips.filter((clip) => !recent.includes(clip) && shown(clip));
  // Topics of one area sit together; a topic with a single clip joins the loose ends, so no block holds one card.
  const order = (topic: Topic) => { const index = areas.findIndex((area) => area.id === topic.area); return index < 0 ? areas.length : index; };
  const blocks = [...topics].sort((a, b) => order(a) - order(b)).map((topic) => ({ topic, items: filed.filter((clip) => clip.topicId === topic.id) })).filter((block) => block.items.length >= 2);
  const inBlocks = new Set(blocks.flatMap((block) => block.items.map((clip) => clip.id)));
  const loose = filed.filter((clip) => !inBlocks.has(clip.id));
  const types = TYPES.filter((candidate) => clips.some((clip) => clip.type === candidate));
  const card = (clip: Clip) => (
    <Card key={clip.id} clip={clip} topics={topics} areas={areas} open={open === clip.id} fresh={fresh.has(`link:${clip.id}`)}
      onOpen={() => setOpen(open === clip.id ? null : clip.id)} onError={setError} />
  );

  return (
    <section className="links" aria-label={t("page.links")}>
      {/* One scroll for the whole page: on a small screen nothing is pinned above the cards. */}
      <div className="lk-scroll">
      <Places places={places} onError={setError} />

      <form className="lk-save" onSubmit={save}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("links.paste")} aria-label={t("links.paste")} maxLength={2400} spellCheck={false} />
        <TopicPick topics={topics} areas={areas} value={"topicId" in pick ? pick.topicId : "+"} label={t("links.topic.pick")} onPick={setPick} />
        <button type="submit" disabled={!found || busy}>{t("links.save")}</button>
      </form>
      {found && kind && (
        <p className="lk-will">
          <span className="tag" data-k="gray">{t(`links.type.${kind.type}` as Key)}</span>
          <span>{platformName(kind.platform) ?? kind.host}</span>
          {found.rest && <span className="lk-note">{found.rest}</span>}
          {"topic" in pick && <span className="tag" data-k="alfred">{pick.topic} · {t("links.topic.isNew")}</span>}
        </p>
      )}
      {draft.trim() && !found && <p className="lk-will quiet">{t("links.noUrl")}</p>}
      {error && <p className="problem small" role="alert">{error}</p>}

        {recent.length > 0 && (
          <section className="lk-band">
            <h3>{t("links.recent")}<span className="count">{recent.length}</span></h3>
            <ul className="lk-cards">{recent.map(card)}</ul>
          </section>
        )}
        {clips.length > 0 && (types.length > 1 || clips.some((clip) => clip.state !== "unread")) && (
          <div className="lk-filters" role="group" aria-label={t("links.filter")}>
            {types.length > 1 && (["all", ...types] as const).map((candidate) => (
              <button type="button" key={candidate} className="chip" aria-pressed={type === candidate} onClick={() => setType(candidate)}>
                {candidate === "all" ? t("common.all") : t(`links.type.${candidate}` as Key)}
                <span className="count">{candidate === "all" ? clips.length : clips.filter((clip) => clip.type === candidate).length}</span>
              </button>
            ))}
            {types.length > 1 && <span className="lk-sep" />}
            {(["unread", "todo"] as const).map((state) => (
              <button type="button" key={state} className="chip" aria-pressed={only === state} onClick={() => setOnly(only === state ? "all" : state)}>{t(`links.state.${state}` as Key)}</button>
            ))}
          </div>
        )}
        {clips.length === 0 && <p className="quiet empty-list">{t("links.empty")}</p>}
        {clips.length > 0 && filed.length === 0 && recent.length === 0 && <p className="quiet empty-list">{t("links.emptyFilter")}</p>}
        {blocks.map(({ topic, items }) => {
          const area = areas.find((candidate) => candidate.id === topic.area);
          return (
            <section className="lk-band lk-topic" key={topic.id} data-k={area?.k ?? "gray"}>
              <h3><span className="mark" />{topic.name}{area && <span className="lk-area">{area.name[getLocale()]}</span>}<span className="count">{items.length}</span></h3>
              <ul className="lk-cards">{items.map(card)}</ul>
            </section>
          );
        })}
        {loose.length > 0 && (
          <section className="lk-band lk-topic" data-k="gray">
            {blocks.length > 0 && <h3><span className="mark" />{t("links.loose")}<span className="count">{loose.length}</span></h3>}
            <ul className="lk-cards">{loose.map(card)}</ul>
          </section>
        )}
      </div>
    </section>
  );
}
