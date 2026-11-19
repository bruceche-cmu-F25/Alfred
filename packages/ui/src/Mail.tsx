import { useEffect, useState } from "react";
import type { MailDetail, MailMessage, MailSnapshot } from "@alfred/module-mail/types";
import { api } from "./api.ts";
import { SourceBar } from "./SourceBar.tsx";
import { intlLocale, t, type Key } from "./i18n/index.ts";

type Filter = "primary" | "unread" | "all";
const FILTERS: Array<[Filter, Key]> = [["primary", "mail.primary"], ["unread", "mail.unread"], ["all", "mail.all"]];

/** Today's mail by its time, older mail by its date. */
function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

function Reader({ message, onBack }: { message: MailMessage; onBack(): void }) {
  const [detail, setDetail] = useState<MailDetail | "loading" | "gone">("loading");
  useEffect(() => {
    let alive = true;
    setDetail("loading");
    api.query<MailDetail | { error: string }>("mail.message", { id: message.id, account: message.account })
      .then((result) => { if (alive) setDetail("error" in result ? "gone" : result); })
      .catch(() => { if (alive) setDetail("gone"); });
    return () => { alive = false; };
  }, [message.id, message.account]);
  return (
    <article className="mail-read" aria-label={message.subject}>
      <button type="button" className="ghost small mail-back" onClick={onBack}>‹ {t("mail.back")}</button>
      <h2>{message.subject}</h2>
      <p className="mail-from"><b>{message.from}</b>{message.from !== message.fromEmail && <span className="quiet"> &lt;{message.fromEmail}&gt;</span>}</p>
      <p className="quiet small">
        {new Date(message.receivedAt).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" })}
        {typeof detail === "object" && detail.to && ` · ${t("mail.to")} ${detail.to}`}
      </p>
      {detail === "loading" && <p className="quiet">{t("mail.loading")}</p>}
      {detail === "gone" && <p className="quiet">{t("mail.gone")}</p>}
      {typeof detail === "object" && (
        <>
          <div className="mail-body">{detail.body || detail.snippet}</div>
          {detail.attachments.length > 0 && <p className="quiet small">{t("mail.attachments", { names: detail.attachments.join(", ") })}</p>}
          {detail.bodyIncomplete && <p className="quiet small">{t("mail.incomplete")}</p>}
        </>
      )}
      <p><a href={message.link} target="_blank" rel="noreferrer noopener">{t("mail.open")}</a></p>
    </article>
  );
}

/** The mail page: the Gmail inbox's last two weeks, newest first, read one message at a time. */
export function Mail({ snapshot }: { snapshot: MailSnapshot | undefined }) {
  const [filter, setFilter] = useState<Filter>("primary");
  const [picked, setPicked] = useState<string | null>(null);
  const messages = snapshot?.messages ?? [];
  const shown = messages.filter((message) => filter === "all" || (filter === "unread" ? message.unread : message.category === "primary"));
  const open = messages.find((message) => `${message.account}|${message.id}` === picked);
  const count = (which: Filter) => messages.filter((message) => which === "all" || (which === "unread" ? message.unread : message.category === "primary")).length;

  return (
    <section className="mail" aria-label={t("page.mail")}>
      <SourceBar module="mail" sources={snapshot?.sources ?? []} notConnected={t("src.notConnected.mail")} />
      {(snapshot?.sources.length ?? 0) > 0 && (
        <>
          <div className="chips" role="group">
            {FILTERS.map(([id, label]) => (
              <button type="button" key={id} className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {t(label)}<span className="count">{count(id)}</span>
              </button>
            ))}
          </div>
          <div className="mail-split" data-reading={open ? true : undefined}>
            <ul className="mail-list">
              {shown.length === 0 && <li className="quiet empty-list">{t("mail.empty")}</li>}
              {shown.map((message) => (
                <li key={`${message.account}|${message.id}`}>
                  <button type="button" className="mail-row" data-unread={message.unread || undefined} aria-current={picked === `${message.account}|${message.id}` || undefined}
                    onClick={() => setPicked(`${message.account}|${message.id}`)}>
                    <span className="mail-dot" aria-hidden="true" />
                    <span className="mail-who">{message.from}</span>
                    <time>{when(message.receivedAt)}</time>
                    <span className="mail-subject">{message.subject}</span>
                    <span className="mail-snippet">{message.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
            {open ? <Reader key={picked} message={open} onBack={() => setPicked(null)} /> : <p className="mail-read quiet mail-pick">{t("mail.pick")}</p>}
          </div>
        </>
      )}
    </section>
  );
}
