/** The client side of @alfred/protocol. Every write carries a request id, so a
 * retry after a dropped connection can never do the same thing twice.
 */
import type {
  Conversation, ConversationDetail, CoreEvent, DeviceInfo, DeviceKind, LiveUpdate, ModelsResponse, Notice, OpResponse, PairingCode, ProposalResponse,
  PushInfo, PushResult, RemoteResponse, Run, StateResponse, SubmitRunResponse, ThinkingLevel, UserSettings, ViewContext,
} from "@alfred/protocol";
import "./desktop.ts";
import { t } from "./i18n/dict.ts";

const DEVICE_KEY = "alfred.device";

function random(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

/** This window's id for claiming notices: the Mac app's when inside it,
 * otherwise this browser's, kept in localStorage when it can be.
 */
export const deviceId: string = (() => {
  if (window.alfredDesktop?.deviceId) return window.alfredDesktop.deviceId;
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored && /^[A-Za-z0-9._:-]{1,40}$/.test(stored)) return stored;
    const id = `web-${random()}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return `web-${random()}`;
  }
})();

export const newRequestId = () => `${deviceId}.${random()}`;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}

/** This device is not paired with the home node (it came in through Tailscale without a device token). */
export const isUnpaired = (error: unknown) => error instanceof ApiError && error.status === 401 && error.code === "unpaired";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // Network failures are retried with the same body (and so the same request id).
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      if (attempt >= 2) throw new ApiError(0, t("api.unreachable"));
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const { error, code } = body as { error?: string; code?: string };
      throw new ApiError(response.status, error ?? t("api.failed", { status: response.status }), code);
    }
    return body as T;
  }
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  state: () => call<StateResponse>("/api/state"),
  /** Without a conversation id, the run starts a new conversation. `context`: the page it was asked from. */
  submit: (goal: string, conversationId?: string, context?: ViewContext) =>
    post<SubmitRunResponse>("/api/runs", { requestId: newRequestId(), goal, ...(conversationId ? { conversationId } : {}), ...(context ? { context } : {}) }),
  conversation: (id: string) => call<ConversationDetail>(`/api/conversations/${id}`),
  updateConversation: (id: string, change: { title?: string; archived?: boolean; model?: string | null; thinking?: ThinkingLevel | null }) =>
    post<Conversation>(`/api/conversations/${id}`, change),
  /** Words into the run now working; rejects with 409 when it is not. */
  steer: (runId: string, text: string) => post<{ delivered: boolean }>(`/api/runs/${runId}/steer`, { text }),
  models: () => call<ModelsResponse>("/api/models"),
  respond: (runId: string, requestId: string, answer: string) => post<Run>(`/api/runs/${runId}/respond`, { requestId, answer }),
  run: (runId: string) => call<{ run: Run }>(`/api/runs/${runId}`),
  cancel: (runId: string) => post<Run>(`/api/runs/${runId}/cancel`, {}),
  resume: (runId: string) => post<Run>(`/api/runs/${runId}/resume`, {}),
  op: (op: string, input: unknown) => post<OpResponse>(`/api/ops/${op}`, { requestId: newRequestId(), input }),
  claim: (id: string) => post<Notice>(`/api/notices/${id}/claim`, { client: deviceId }),
  present: (id: string) => post<Notice>(`/api/notices/${id}/present`, { client: deviceId }),
  acknowledge: (id: string) => post<Notice>(`/api/notices/${id}/acknowledge`, {}),
  /** The user's decision on a proposal. A retry with the same request id gets the same answer. */
  accept: (id: string, requestId = newRequestId()) => post<ProposalResponse>(`/api/proposals/${id}/accept`, { requestId }),
  decline: (id: string) => post<ProposalResponse>(`/api/proposals/${id}/decline`, { requestId: newRequestId() }),
  revise: (id: string, text: string) => post<ProposalResponse>(`/api/proposals/${id}/revise`, { requestId: newRequestId(), text }),
  /** The user's preferences that are not secrets, shared by every device (for now, the language). */
  settings: (patch: Partial<UserSettings>) => post<UserSettings>("/api/settings", { requestId: newRequestId(), patch }),
  /** Remote access and devices: on this machine the switch and the list, on another device just itself. */
  remote: () => call<RemoteResponse>("/api/remote"),
  setRemote: (enabled: boolean) => post<RemoteResponse>("/api/remote", { enabled }),
  pairingCode: () => post<PairingCode>("/api/remote/pairing", {}),
  revokeDevice: (id: string) => post<RemoteResponse>(`/api/devices/${id}/revoke`, {}),
  /** On a device that is not paired yet: the home node answers with the device token in a cookie. */
  pair: (code: string, name: string, kind: DeviceKind) => post<{ device: DeviceInfo }>("/api/pair", { code, name, kind }),
  forgetDevice: () => post<Record<string, never>>("/api/device/forget", {}),
  /** Push notifications for this (paired) device. */
  pushInfo: () => call<PushInfo>("/api/push"),
  pushSubscribe: (subscription: PushSubscriptionJSON) => post<PushInfo>("/api/push/subscribe", { subscription }),
  pushUnsubscribe: () => post<PushInfo>("/api/push/unsubscribe", {}),
  pushTest: () => post<PushResult>("/api/push/test", {}),
};

export type Connection = "connecting" | "live" | "reconnecting";

/** Follows the event stream from `after`. EventSource resumes from the last
 * id it saw on its own after a drop.
 */
export function subscribe(
  after: number,
  handlers: { event(event: CoreEvent): void; live(update: LiveUpdate): void; connection(state: Connection): void },
): () => void {
  const source = new EventSource(`/api/events?after=${after}`);
  source.addEventListener("open", () => handlers.connection("live"));
  source.addEventListener("error", () => handlers.connection("reconnecting"));
  source.addEventListener("core", (message) => handlers.event(JSON.parse((message as MessageEvent<string>).data) as CoreEvent));
  source.addEventListener("live", (message) => handlers.live(JSON.parse((message as MessageEvent<string>).data) as LiveUpdate));
  return () => source.close();
}
