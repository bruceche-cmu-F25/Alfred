import { useState } from "react";
import { api } from "./api.ts";
import { t } from "./i18n/index.ts";

export interface Source { account: string; syncedAt: string | null; error: string | null; reconnect: boolean }

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** Where a mirrored page's data comes from: not connected (go to Settings), can't be read (why), or when it was
 * read, with a button to read it again now. */
export function SourceBar({ module, sources, notConnected }: { module: string; sources: Source[]; notConnected: string }) {
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    setBusy(true);
    api.syncModule(module).catch(() => {}).finally(() => setBusy(false));
  };
  if (!sources.length) {
    return <p className="source-bar"><span>{notConnected}</span><a href="#p=core.settings">{t("src.connect")}</a></p>;
  }
  const broken = sources.find((source) => source.error);
  const read = sources.map((source) => source.syncedAt).filter((at): at is string => !!at).sort().at(-1);
  return (
    <p className="source-bar" data-problem={broken ? true : undefined}>
      {broken
        ? broken.reconnect
          ? <><span>{t("src.reconnect")}</span><a href="#p=core.settings">{t("src.connect")}</a></>
          : <span title={broken.account}>{t("src.error", { error: broken.error! })}</span>
        : read && <span>{t("src.synced", { when: hhmm(read) })}</span>}
      <button type="button" className="ghost small" disabled={busy} onClick={refresh}>{t(busy ? "src.refreshing" : "src.refresh")}</button>
    </p>
  );
}
