/** Settings → General: the name and language (shared by every device), and what this device prefers:
 * light or dark, the size of the text, and which key sends (after pi-web's Settings › General,
 * github.com/agegr/pi-web, MIT).
 */
import { useState, type FormEvent } from "react";
import type { NamePreference } from "./InboxEntry.tsx";
import { api } from "./api.ts";
import { setLocale, t, useLocale, type Key, type Locale } from "./i18n/index.ts";
import { SEND_KEYS, setSendKey, setTextSize, TEXT_SIZES, useSendKey, useTextSize } from "./prefs.ts";
import { origin, setAppearance, useAppearance, type Appearance } from "./scheme.ts";

/** Each language named in itself. */
const LANGUAGES: Array<[Locale, string]> = [["zh", "中文"], ["en", "English"]];
const APPEARANCES: Appearance[] = ["system", "light", "dark"];
/** ⌘ on a Mac or an iPhone, Ctrl elsewhere. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export function General({ name: savedName, saveName }: NamePreference) {
  const locale = useLocale();
  const appearance = useAppearance();
  const textSize = useTextSize();
  const sendKey = useSendKey();
  const [error, setError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);

  const name = draftName ?? savedName ?? "";
  const canSaveName = !!name.trim() && name.trim() !== savedName && !savingName;
  const submitName = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSaveName) return;
    setSavingName(true);
    setError(null);
    try {
      await saveName(name.trim());
      setDraftName(null);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSavingName(false);
    }
  };

  const chooseLanguage = (next: Locale) => {
    // The UI switches at once; the home node keeps it, and every device follows.
    setLocale(next);
    api.settings({ locale: next }).catch((reason: Error) => setError(reason.message));
  };

  return (
    <section className="set-section">
      <h2>{t("settings.general")}</h2>
      {error && <p className="problem small" role="alert">{error}</p>}
      <div className="set-rows">
        <form className="set-row set-preferred-name" onSubmit={submitName} aria-busy={savingName}>
          <label className="set-name" htmlFor="preferred-name">{t("settings.preferredName")}</label>
          <span className="set-note">{t("settings.language.note")}</span>
          <div className="set-end">
            <input id="preferred-name" className="model-input" autoComplete="nickname" maxLength={80}
              value={name} disabled={savingName} onChange={(event) => {
                setDraftName(event.target.value === savedName ? null : event.target.value);
              }} />
            <button type="submit" className="set-button" disabled={!canSaveName}>{t("settings.save")}</button>
          </div>
        </form>
        <div className="set-row">
          <span className="set-name">{t("settings.language")}</span>
          <span className="set-note">{t("settings.language.note")}</span>
          <span className="set-end">
            <span className="chips set-chips" role="radiogroup" aria-label={t("settings.language")}>
              {LANGUAGES.map(([id, name]) => (
                <button type="button" key={id} className="chip" role="radio" aria-checked={locale === id} aria-pressed={locale === id}
                  lang={id === "zh" ? "zh-CN" : "en"} onClick={() => chooseLanguage(id)}>{name}</button>
              ))}
            </span>
          </span>
        </div>
        <div className="set-row">
          <span className="set-name">{t("settings.appearance")}</span>
          <span className="set-note">{t("settings.appearance.note")}</span>
          <span className="set-end">
            <span className="chips set-chips" role="radiogroup" aria-label={t("settings.appearance")}>
              {APPEARANCES.map((id) => (
                <button type="button" key={id} className="chip" role="radio" aria-checked={appearance === id} aria-pressed={appearance === id}
                  onClick={(event) => setAppearance(id, origin(event))}>{t(`settings.appearance.${id}`)}</button>
              ))}
            </span>
          </span>
        </div>
        <div className="set-row">
          <span className="set-name">{t("settings.textSize")}</span>
          <span className="set-note">{t("settings.thisDevice")}</span>
          <span className="set-end">
            <span className="chips set-chips" role="radiogroup" aria-label={t("settings.textSize")}>
              {TEXT_SIZES.map((id) => (
                <button type="button" key={id} className="chip" role="radio" aria-checked={textSize === id} aria-pressed={textSize === id}
                  onClick={() => setTextSize(id)}>{t(`settings.textSize.${id}` as Key)}</button>
              ))}
            </span>
          </span>
        </div>
        <div className="set-row">
          <span className="set-name">{t("settings.sendKey")}</span>
          <span className="set-note">{t(sendKey === "enter" ? "settings.sendKey.enter.note" : "settings.sendKey.mod.note", { mod: MOD })}</span>
          <span className="set-end">
            <span className="chips set-chips" role="radiogroup" aria-label={t("settings.sendKey")}>
              {SEND_KEYS.map((id) => (
                <button type="button" key={id} className="chip" role="radio" aria-checked={sendKey === id} aria-pressed={sendKey === id}
                  onClick={() => setSendKey(id)}>{id === "enter" ? "Enter" : `${MOD}Enter`}</button>
              ))}
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}
