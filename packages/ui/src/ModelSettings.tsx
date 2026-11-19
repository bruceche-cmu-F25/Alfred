/** Settings → Models: who Alfred thinks with (docs/design/settings-and-connections.md §3.2).
 *
 * Signing in runs on the home node through Pi. This page starts it and follows it: it opens the provider's page,
 * shows a device code, or asks for a key, as Pi's flow asks. The default model and thinking level are the user's
 * settings, used by any conversation that has not chosen its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineModel, ModelAccountsResponse, ModelAuthMethod, ModelProvider, ModelSignIn, StateResponse, ThinkingLevel } from "@alfred/protocol";
import { api } from "./api.ts";
import { t } from "./i18n/index.ts";

/** API-key providers shown before "show all": the ones most people have. Configured ones always show. */
const COMMON = ["anthropic", "openai", "google", "openrouter", "deepseek", "xai", "mistral", "groq", "moonshotai", "kimi-coding"];
const THINKING: Array<ThinkingLevel | null> = [null, "off", "low", "medium", "high", "xhigh"];
const PI_DISMISSED = "alfred.models.piDismissed";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((value as { error?: string }).error ?? t("settings.requestFailed", { status: response.status }));
  return value as T;
}
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const dismissedPi = () => { try { return localStorage.getItem(PI_DISMISSED) === "1"; } catch { return false; } };

type Said = { kind: "done" | "signedOut"; name: string } | { kind: "imported"; n: number };

export function ModelSettings() {
  const [data, setData] = useState<ModelAccountsResponse | null>(null);
  const [models, setModels] = useState<EngineModel[]>([]);
  const [preferred, setPreferred] = useState<{ model: string | null; thinking: ThinkingLevel | null }>({ model: null, thinking: null });
  const [flow, setFlow] = useState<ModelSignIn | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [piHidden, setPiHidden] = useState(dismissedPi);
  const [copied, setCopied] = useState(false);
  const opened = useRef(new Set<string>());

  const load = useCallback(() => {
    call<ModelAccountsResponse>("/api/connections/models").then(setData, (reason: Error) => setError(reason.message));
    api.models().then((response) => setModels(response.models), () => setModels([]));
  }, []);
  useEffect(() => {
    load();
    call<StateResponse>("/api/state").then((state) => setPreferred({ model: state.settings.model ?? null, thinking: state.settings.thinking ?? null }), () => {});
  }, [load]);

  // Follow a sign-in while it runs; open the provider's page the first time it appears (the Mac app sends it to the
  // system browser; a plain browser may block it, so the card has a link too).
  useEffect(() => {
    if (!flow || flow.status !== "running") return;
    const timer = setInterval(() => {
      call<ModelSignIn>(`/api/connections/models/flows/${flow.id}`).then((next) => {
        setFlow(next);
        if (next.status !== "running") {
          const name = data?.providers.find((provider) => provider.id === next.provider)?.name ?? next.provider;
          if (next.status === "done") setSaid({ kind: "done", name });
          if (next.status === "failed") setError(t("models.failed", { error: next.error ?? "" }));
          load();
        }
      }, () => {});
    }, 800);
    return () => clearInterval(timer);
  }, [flow, data, load]);
  useEffect(() => {
    for (const step of flow?.steps ?? []) {
      const url = step.kind === "open_url" ? step.url : step.kind === "device_code" ? step.url : null;
      if (!url || opened.current.has(url)) continue;
      opened.current.add(url);
      if (step.kind === "open_url") { const page = window.open(url, "_blank"); if (page) page.opener = null; }
    }
  }, [flow]);

  const start = (provider: ModelProvider, method: ModelAuthMethod) => {
    setError(null);
    setSaid(null);
    setAnswer("");
    setCopied(false);
    call<ModelSignIn>(`/api/connections/models/${provider.id}/login`, { method }).then(setFlow, (reason: Error) => setError(reason.message));
  };
  const cancel = () => {
    if (flow) call<ModelSignIn>(`/api/connections/models/flows/${flow.id}/cancel`, {}).then(setFlow, () => setFlow(null));
  };
  const reply = (value: string) => {
    if (!flow?.prompt) return;
    call<ModelSignIn>(`/api/connections/models/flows/${flow.id}/answer`, { promptId: flow.prompt.id, value }).then((next) => { setFlow(next); setAnswer(""); }, (reason: Error) => setError(reason.message));
  };
  const logout = (provider: ModelProvider) => {
    setError(null);
    call<ModelAccountsResponse>(`/api/connections/models/${provider.id}/logout`, {}).then((next) => {
      setData(next);
      setSaid({ kind: "signedOut", name: provider.name });
      api.models().then((response) => setModels(response.models), () => {});
    }, (reason: Error) => setError(reason.message));
  };
  const importPi = () => {
    if (!data) return;
    call<ModelAccountsResponse>("/api/connections/models/import", { providers: data.piKeys.map((item) => item.id) }).then((next) => {
      setSaid({ kind: "imported", n: data.piKeys.length - next.piKeys.length });
      setData(next);
      api.models().then((response) => setModels(response.models), () => {});
    }, (reason: Error) => setError(reason.message));
  };
  const skipPi = () => {
    setPiHidden(true);
    try { localStorage.setItem(PI_DISMISSED, "1"); } catch { /* this view only */ }
  };
  const choose = (patch: { model?: string | null; thinking?: ThinkingLevel | null }) => {
    setPreferred((current) => ({ ...current, ...patch }));
    api.settings(patch).catch((reason: Error) => setError(reason.message));
  };

  const piSub = new Set(data?.piSubscriptions.map((item) => item.id) ?? []);
  const statusOf = (provider: ModelProvider, kind: "subscription" | "key") => {
    const { status } = provider;
    // "Signed in in Pi" is about the subscription, so only its row says so.
    if (!status.configured) return kind === "subscription" && piSub.has(provider.id) ? <span className="set-status need">{t("models.status.pi")}</span> : null;
    if (status.source === "environment") return <span className="set-status on">{t("models.status.env")}</span>;
    return <span className="set-status on">{t(status.method === "oauth" ? "models.status.oauth" : "models.status.key")}</span>;
  };

  const flowCard = (provider: ModelProvider) => {
    if (!flow || flow.provider !== provider.id || flow.status !== "running") return null;
    const last = flow.steps.at(-1);
    const prompt = flow.prompt;
    return (
      <div className="set-flow">
        {flow.steps.map((step, index) => {
          if (step.kind === "open_url") {
            return (
              <div key={index} className="set-actions">
                <a className="set-button" href={step.url} target="_blank" rel="noopener noreferrer">{t("models.flow.open")}</a>
                {step.instructions && <span className="quiet small">{step.instructions}</span>}
              </div>
            );
          }
          if (step.kind === "device_code") {
            return (
              <div key={index} className="model-device">
                <span className="small">{t("models.flow.device")}</span>
                <span className="model-code">{step.code}</span>
                <div className="set-actions">
                  <a className="set-button" href={step.url} target="_blank" rel="noopener noreferrer">{t("models.flow.openDevice", { host: host(step.url) })}</a>
                  <button type="button" className="set-button ghost" onClick={() => { void navigator.clipboard?.writeText(step.code).then(() => setCopied(true), () => {}); }}>
                    {copied ? t("models.flow.copied") : t("models.flow.copy")}
                  </button>
                </div>
              </div>
            );
          }
          if (step.kind === "info") {
            return (
              <p key={index} className="small">{step.message}{step.links?.map((link) => (
                <a key={link.url} className="dev-link" href={link.url} target="_blank" rel="noopener noreferrer"> {link.label ?? host(link.url)}</a>
              ))}</p>
            );
          }
          return null;
        })}
        {prompt ? (
          prompt.type === "select" ? (
            <div className="set-actions">
              <span className="small">{prompt.message}</span>
              {prompt.options?.map((option) => (
                <button type="button" key={option.id} className="set-button ghost" title={option.description} onClick={() => reply(option.id)}>{option.label}</button>
              ))}
            </div>
          ) : (
            <form className="model-answer" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) reply(answer.trim()); }}>
              <label className="small" htmlFor={`answer-${flow.id}`}>{prompt.message}</label>
              <div className="set-actions">
                <input id={`answer-${flow.id}`} className="model-input" type={prompt.type === "secret" ? "password" : "text"} value={answer}
                  placeholder={prompt.placeholder} autoComplete="off" spellCheck={false} autoFocus onChange={(event) => setAnswer(event.target.value)} />
                <button type="submit" className="set-button" disabled={!answer.trim()}>{t(prompt.type === "secret" ? "models.flow.save" : "models.flow.submit")}</button>
              </div>
            </form>
          )
        ) : (
          <div className="set-flow-head small"><span className="pulse" />{last?.kind === "progress" ? last.message : t("models.flow.waiting")}</div>
        )}
        <div className="set-actions"><button type="button" className="set-button ghost" onClick={cancel}>{t("common.cancel")}</button></div>
      </div>
    );
  };

  const busy = flow?.status === "running";
  const row = (provider: ModelProvider, kind: "subscription" | "key") => {
    const ours = provider.status.configured && provider.status.source === "alfred";
    const oauthOn = ours && provider.status.method === "oauth";
    const keyOn = ours && provider.status.method === "api_key";
    return (
      <div className="set-rows-item" key={provider.id}>
        <div className="set-row has-logo">
          <span className="set-logo" data-k="gray">{provider.name.slice(0, 1).toUpperCase()}</span>
          <span className="set-name">{provider.name}</span>
          <span className="set-note">{kind === "subscription" ? provider.oauth?.label : t("models.provider.models", { n: provider.models })}</span>
          <span className="set-end">
            {statusOf(provider, kind)}
            {kind === "subscription" ? (
              oauthOn
                ? <button type="button" className="set-button ghost" onClick={() => logout(provider)}>{t("models.signOut")}</button>
                : <button type="button" className="set-button" disabled={busy} onClick={() => start(provider, "oauth")}>{t("models.signIn")}</button>
            ) : (
              <>
                {provider.oauth && !provider.oauth.subscription && !ours && (
                  <button type="button" className="set-button ghost" disabled={busy} onClick={() => start(provider, "oauth")}>{t("models.signIn")}</button>
                )}
                <button type="button" className={keyOn ? "set-button ghost" : "set-button"} disabled={busy} onClick={() => start(provider, "api_key")}>
                  {t(keyOn ? "models.changeKey" : "models.addKey")}
                </button>
                {ours && <button type="button" className="set-button ghost" onClick={() => logout(provider)}>{t(oauthOn ? "models.signOut" : "models.removeKey")}</button>}
              </>
            )}
          </span>
        </div>
        {flowCard(provider)}
      </div>
    );
  };

  const providers = data?.providers ?? [];
  const subscriptions = providers.filter((provider) => provider.oauth?.subscription);
  const keyed = providers.filter((provider) => provider.apiKey).sort((a, b) => {
    const rank = (provider: ModelProvider) => (COMMON.includes(provider.id) ? COMMON.indexOf(provider.id) : COMMON.length);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  const shownKeys = showAll ? keyed : keyed.filter((provider) => COMMON.includes(provider.id) || provider.status.configured || flow?.provider === provider.id);
  const modelOptions = models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.name} · ${providers.find((provider) => provider.id === model.provider)?.name ?? model.provider}` }));
  const piSubNames = data?.piSubscriptions.map((item) => item.name) ?? [];

  return (
    <section className="set-section">
      <h2>{t("settings.models")}</h2>
      <p className="quiet">{t("models.sub")}</p>
      {error && <p className="problem small" role="alert">{error}</p>}
      {said && (
        <p className="set-message" role="status">
          {said.kind === "imported" ? t("models.imported", { n: said.n }) : t(said.kind === "done" ? "models.done" : "models.signedOut", { name: said.name })}
        </p>
      )}

      {data && data.piKeys.length > 0 && !piHidden && (
        <div className="set-flow">
          <span>{t("models.pi.keys", { names: data.piKeys.map((item) => item.name).join(t("list.sep")) })}</span>
          <div className="set-actions">
            <button type="button" className="set-button" onClick={importPi}>{t("models.pi.import")}</button>
            <button type="button" className="set-button ghost" onClick={skipPi}>{t("models.pi.skip")}</button>
          </div>
        </div>
      )}

      <div className="set-rows">
        <div className="set-row">
          <span className="set-name">{t("models.default")}</span>
          <span className="set-note">{t("models.default.note")}</span>
          <span className="set-end">
            {modelOptions.length ? (
              <select className="model-select" value={preferred.model ?? ""} onChange={(event) => choose({ model: event.target.value || null })}>
                <option value="">{t("models.default.engine")}</option>
                {preferred.model && !modelOptions.some((option) => option.value === preferred.model) && <option value={preferred.model}>{preferred.model}</option>}
                {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ) : <span className="quiet small">{t("models.default.none")}</span>}
          </span>
        </div>
        <div className="set-row">
          <span className="set-name">{t("models.thinking")}</span>
          <span className="set-note">{t("models.thinking.note")}</span>
          <span className="set-end">
            <select className="model-select" value={preferred.thinking ?? ""} onChange={(event) => choose({ thinking: (event.target.value || null) as ThinkingLevel | null })}>
              {THINKING.map((level) => <option key={level ?? "default"} value={level ?? ""}>{t(level ? `models.thinking.${level}` as Parameters<typeof t>[0] : "models.thinking.default")}</option>)}
            </select>
          </span>
        </div>
      </div>

      <h3 className="set-sub">{t("models.subs")}</h3>
      <p className="quiet small">{t("models.subs.note")}</p>
      {piSubNames.length > 0 && <p className="quiet small">{t("models.pi.subs", { names: piSubNames.join(t("list.sep")), n: piSubNames.length })}</p>}
      <div className="set-rows">{subscriptions.map((provider) => row(provider, "subscription"))}</div>

      <h3 className="set-sub">{t("models.keys")}</h3>
      <p className="quiet small">{t("models.keys.note")}</p>
      <div className="set-rows">{shownKeys.map((provider) => row(provider, "key"))}</div>
      {keyed.length > shownKeys.length || showAll ? (
        <div className="set-actions">
          <button type="button" className="set-button ghost" onClick={() => setShowAll(!showAll)}>{showAll ? t("models.keys.fewer") : t("models.keys.all", { n: keyed.length })}</button>
        </div>
      ) : null}
    </section>
  );
}
