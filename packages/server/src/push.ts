/** Web Push to paired devices (docs/research/remote-access.md): the phones' notifications, as one outlet the home node
 * can reach by itself. This file knows how to send; it does not decide. Which notices go to the phone, and when, is
 * the attention table's to say (core attention.ts), and the home node's attention (attention.ts) does the handing: a
 * notice nobody took is pushed to every subscribed device and then held as `push`, so the Mac does not show it again
 * later. A push service accepting it is not proof the user saw it, so it is held, not presented.
 *
 * Lessons carried over from Robin: Apple refuses a VAPID subject that is not a valid URL; urgency `high`, or an idle
 * iPhone delays delivery; a 404/410 means the subscription is gone. Subscriptions live in <data>/push.json (0600),
 * one per device; the VAPID private key lives in the secret store.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import { listDevices, userLocale, type Outlet, type World } from "@alfred/core";
import { translate, type Key } from "@alfred/ui/i18n";
import type { Reach } from "./attention.ts";
import type { SecretStore } from "./secrets.ts";

export interface PushSubscriptionJson { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushMessage {
  title: string;
  body: string;
  /** Same-origin path opened when the notification is tapped. */
  url: string;
  /** Notifications with one tag replace each other. */
  tag: string;
  /** The notice it is about; tapping it acknowledges the notice when `ack`. */
  notice?: string;
  ack?: boolean;
}
export interface PushResult { accepted: number; failed: number; expired: number }
interface VapidKeys { publicKey: string; privateKey: string }
type Subscriptions = Record<string, PushSubscriptionJson & { at: string }>;
/** Sends one payload; rejects with an error carrying `statusCode` when the push service refuses. */
export type PushSender = (subscription: PushSubscriptionJson, payload: string, keys: VapidKeys) => Promise<void>;

/** How long a pushed notice stays push's before the Mac may show it after all. */
const PUSH_CLAIM_MS = 12 * 3600_000;
const SECRET = "push:vapid";
export const PUSH_CLIENT = "push";
/** The phones' push notifications, as the attention table sees them: one outlet, which nobody is ever looking at. */
const PUSH_OUTLET: Outlet = { id: PUSH_CLIENT, kind: "push", attending: false };
/** Push services of the browsers people use. Anything else is refused, so a device cannot make the node call elsewhere. */
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

export class PushError extends Error {
  override name = "PushError";
}

export function subject(): string {
  return process.env.ALFRED_PUSH_SUBJECT?.trim() || "https://github.com/bruceche-cmu-F25/Alfred";
}

const defaultSender: PushSender = async (subscription, payload, keys) => {
  await webpush.sendNotification(subscription, payload, {
    vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: PUSH_CLAIM_MS / 1000, urgency: "high", timeout: 15_000,
  });
};

export function checkSubscription(value: unknown): PushSubscriptionJson {
  const sub = value as Partial<PushSubscriptionJson> | null;
  const text = (item: unknown, max: number) => typeof item === "string" && item.length > 0 && item.length <= max && /^[A-Za-z0-9_=-]+$/.test(item);
  if (!sub || typeof sub.endpoint !== "string" || sub.endpoint.length > 1000 || !sub.keys || !text(sub.keys.p256dh, 200) || !text(sub.keys.auth, 100)) {
    throw new PushError("Not a push subscription");
  }
  let url: URL;
  try { url = new URL(sub.endpoint); } catch { throw new PushError("Not a push subscription"); }
  if (url.protocol !== "https:" || url.port || !PUSH_HOSTS.some((host) => host.test(url.hostname))) throw new PushError("Unknown push service");
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

/** What a notice says on a lock screen, in the user's language (the Mac's notifications say the same). */
export function noticeMessage(notice: { id: string; kind: string; payload: Record<string, unknown> }, locale: "zh" | "en"): PushMessage {
  const say = (key: string, vars?: Record<string, string>) => translate(locale, key as Key, vars);
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const goal = cut(String(notice.payload.goal ?? ""), 120);
  const conversation = typeof notice.payload.conversationId === "string" ? notice.payload.conversationId : null;
  const at = conversation ? `/#c=${encodeURIComponent(conversation)}` : "/";
  const base = { tag: `notice:${notice.id}`, notice: notice.id };
  if (notice.kind === "proposal") {
    return { ...base, title: say("mac.proposal.title"), body: cut(String(notice.payload.title ?? ""), 200), url: "/#p=core.inbox", ack: false };
  }
  if (notice.kind === "run_request") {
    const title = say(notice.payload.kind === "permission" ? "mac.permission.title" : "mac.input.title");
    return { ...base, title, body: cut(String(notice.payload.question ?? goal), 200), url: at, ack: false };
  }
  if (notice.kind === "run_interrupted") return { ...base, title: say("mac.interrupted.title"), body: say("mac.interrupted.body", { goal }), url: at, ack: true };
  if (notice.kind === "outbound") {
    // A change outside Alfred (an event, an email) after the user's yes: it is told on the phone when it did not go
    // through, or may not have. That stays in the inbox until they have looked.
    const preview = cut(String(notice.payload.preview ?? ""), 120);
    const error = notice.payload.error ? cut(String(notice.payload.error), 100) : "";
    const inbox = "/#p=core.inbox";
    if (notice.payload.state === "failed") return { ...base, title: say("mac.outbound.failed"), body: error ? say("mac.outbound.failedBody", { preview, error }) : preview, url: inbox, ack: false };
    if (notice.payload.state === "unknown") return { ...base, title: say("mac.outbound.unknown"), body: say("mac.outbound.unknownBody", { preview }), url: inbox, ack: false };
    return { ...base, title: say("mac.outbound.done"), body: preview, url: inbox, ack: true };
  }
  const status = notice.payload.status;
  if (status === "failed") return { ...base, title: say("mac.failed.title"), body: say("mac.goal", { goal }), url: at, ack: true };
  if (status === "cancelled") return { ...base, title: say("mac.cancelled.title"), body: say("mac.goal", { goal }), url: at, ack: true };
  const reply = typeof notice.payload.reply === "string" && notice.payload.reply.trim() ? cut(notice.payload.reply.trim(), 200) : say("mac.done.body", { goal });
  return { ...base, title: "Alfred", body: reply, url: at, ack: true };
}

export interface PushOptions {
  dataDir: string;
  world: World;
  secrets: SecretStore;
  send?: PushSender;
  log?: (message: string) => void;
}

export class PushService {
  readonly #options: PushOptions;
  readonly #file: string;
  readonly #send: PushSender;
  #subscriptions: Subscriptions = {};
  #keys: Promise<VapidKeys> | null = null;

  constructor(options: PushOptions) {
    this.#options = options;
    this.#file = join(options.dataDir, "push.json");
    this.#send = options.send ?? defaultSender;
    try {
      const stored = JSON.parse(readFileSync(this.#file, "utf8")) as { subscriptions?: Subscriptions };
      this.#subscriptions = stored.subscriptions ?? {};
    } catch { /* first start */ }
  }

  /** Made once and kept; the private half never leaves the secret store and this process. */
  keys(): Promise<VapidKeys> {
    this.#keys ??= (async () => {
      const stored = await this.#options.secrets.get(SECRET);
      if (stored) return JSON.parse(stored) as VapidKeys;
      const fresh = webpush.generateVAPIDKeys();
      await this.#options.secrets.set(SECRET, JSON.stringify(fresh));
      return fresh;
    })();
    this.#keys.catch(() => { this.#keys = null; });
    return this.#keys;
  }

  async publicKey(): Promise<string> { return (await this.keys()).publicKey; }
  subscribed(deviceId: string): boolean { return deviceId in this.#subscriptions; }

  subscribe(deviceId: string, subscription: unknown): void {
    this.#subscriptions[deviceId] = { ...checkSubscription(subscription), at: new Date().toISOString() };
    this.#save();
  }

  unsubscribe(deviceId: string): void {
    if (!(deviceId in this.#subscriptions)) return;
    delete this.#subscriptions[deviceId];
    this.#save();
  }

  /** To the given devices (default: every paired device that subscribed). Gone subscriptions are dropped. */
  async sendTo(message: PushMessage, deviceIds?: string[]): Promise<PushResult> {
    const paired = new Set(listDevices(this.#options.world).map((device) => device.id));
    const targets = Object.keys(this.#subscriptions).filter((id) => paired.has(id) && (!deviceIds || deviceIds.includes(id)));
    const result: PushResult = { accepted: 0, failed: 0, expired: 0 };
    if (!targets.length) return result;
    const keys = await this.keys();
    const payload = JSON.stringify(message);
    for (const id of targets) {
      const subscription = this.#subscriptions[id];
      try {
        await this.#send(subscription, payload, keys);
        result.accepted++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) { this.unsubscribe(id); result.expired++; }
        else { result.failed++; this.#options.log?.(`push to ${id} failed: ${status ?? ""} ${(error as Error).message}`); }
      }
    }
    return result;
  }

  /** The phones as the home node's attention reaches them: one outlet, there only while a device has notifications
   * on. Sending is to every subscribed device; it counts as gone out when at least one push service took it. */
  reaches(): Reach[] {
    if (!Object.keys(this.#subscriptions).length) return [];
    return [{
      outlet: PUSH_OUTLET,
      holdMs: PUSH_CLAIM_MS,
      send: async (notice) => (await this.sendTo(noticeMessage(notice, userLocale(this.#options.world)))).accepted > 0,
    }];
  }

  #save(): void {
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify({ subscriptions: this.#subscriptions }, null, 2), { mode: 0o600 });
    renameSync(temp, this.#file);
  }
}
