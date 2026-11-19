/** The client protocol over HTTP (see @alfred/protocol), plus the UI's files.
 *
 * Two listeners, both on loopback:
 * - the local port, for this machine (the Mac app, a browser here): it accepts requests only for a loopback Host
 *   (DNS-rebinding defence) and, when a browser sends an Origin, only from itself; everything is allowed.
 * - the ingress port (remote.ts), which only Tailscale Serve forwards to: every request is another device's and,
 *   apart from the UI's files and pairing, needs a paired device's token. Devices cannot touch credentials,
 *   remote access or other devices; those stay on this machine.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import {
  AREAS, acceptProposal, declineProposal, getSettings, listOpenProposals, supersedeProposal, runCommand, updateSettings, userLocale, withCoreContext,
  acknowledgeNotice, answerRequest, claimNotice, getConversation, getRun, latestEventSeq, listConversations, listEvents, listNotices,
  listRunActivity, listRunReceipts, listRuns, presentNotice, reportPresence, requestCancel, resumeRun, submitRun, updateConversation,
  deviceForToken, DEVICE_KINDS, type Device, type DeviceKind, type LiveUpdate,
} from "@alfred/core";
import { applyStep, invokeOp } from "@alfred/module-kit";
import type {
  ConversationDetail, CoreEvent, ErrorResponse, ModelsResponse, NoticeRequest, OpRequest, PairRequest, PresenceRequest, ProposalRequest, ProposalResponse, PushInfo, PushResult,
  RemoteResponse, RespondRequest, ReviseRequest, SettingsRequest, StateResponse, SteerRequest, SubmitRunRequest, UpdateConversationRequest,
} from "@alfred/protocol";
import { PROTOCOL_VERSION } from "@alfred/protocol";
import { ASSISTANT_PROFILE, type Home } from "./home.ts";
import { handleConnections } from "./connections-http.ts";
import type { GoogleConnections } from "./google.ts";
import { DEVICE_COOKIE, type RemoteAccess } from "./remote.ts";
import type { PushService } from "./push.ts";

const MAX_BODY = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};
/** A year and a bit; revoking on the Mac ends it sooner. */
const COOKIE_MAX_AGE = 400 * 24 * 3600;

/** Who is asking: this machine, or another device (paired or not) that came through Tailscale Serve. */
type Peer = { local: true } | { local: false; device: Device | null; login: string | null };

class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host ?? "";
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  return !!match && LOOPBACK_HOSTS.has(match[1].toLowerCase()) && Number(match[2] ?? 80) === port;
}

/** The ingress takes this machine's tailnet name (through Serve, which keeps the Host) or its own loopback port. */
function ingressHostAllowed(req: IncomingMessage, port: number, dnsName: string | null): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!match) return false;
  if (dnsName && match[1] === dnsName.toLowerCase()) return true;
  return LOOPBACK_HOSTS.has(match[1]) && Number(match[2] ?? 80) === port;
}

function cookieToken(req: IncomingMessage): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === DEVICE_COOKIE) return value.join("=");
  }
  return "";
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Send JSON");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as T;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function statusOf(error: unknown): { status: number; body: ErrorResponse } {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "Request failed";
  const code = (error as { code?: unknown }).code;
  if (name === "SettingsError") return { status: 400, body: { error: message } };
  if (name === "DeviceError") return { status: code === "missing" ? 404 : 400, body: { error: message, code: String(code) } };
  if (name === "PairingError") return { status: 400, body: { error: message, code: String(code) } };
  if (name === "RemoteError") return { status: 409, body: { error: message } };
  if (name === "PushError") return { status: 400, body: { error: message } };
  if (name === "ProposalStateError") {
    const state = (error as { state?: string }).state;
    return { status: state === "missing" ? 404 : 409, body: { error: message, code: state ?? "state" } };
  }
  if (name === "RunError" || name === "NoticeStateError" || name === "ConversationError") {
    if (code === "invalid") return { status: 400, body: { error: message, code: "invalid" } };
    return { status: code === "missing" ? 404 : 409, body: { error: message, code: String(code) } };
  }
  if (name === "UnknownOpError") return { status: 404, body: { error: message } };
  if (name.endsWith("ConflictError")) return { status: 409, body: { error: message, code: "conflict" } };
  if (name === "OpInputError" || name === "Error") return { status: 400, body: { error: message } };
  return { status: 500, body: { error: "Internal error" } };
}

function state(home: Home): StateResponse {
  // One synchronous read: no commit can land between these statements.
  const modules: Record<string, unknown> = {};
  for (const module of home.modules) if (module.snapshot) modules[module.id] = module.snapshot(home.world);
  const runs = listRuns(home.world, { limit: 50 });
  const views: StateResponse["views"] = {};
  for (const module of home.modules) if (module.views?.length) views[module.id] = module.views.map((view) => ({ id: view.id, title: view.title }));
  return {
    protocol: PROTOCOL_VERSION,
    cursor: latestEventSeq(home.world),
    conversations: listConversations(home.world),
    runs,
    receipts: listRunReceipts(home.world, runs.map((run) => run.id)),
    // Presented ones too: the device that showed one keeps showing it until acknowledged.
    notices: listNotices(home.world, { states: ["pending", "claimed", "presented"] }),
    modules,
    views,
    areas: [...AREAS],
    proposals: listOpenProposals(home.world),
    settings: getSettings(home.world),
  };
}

function conversationDetail(home: Home, id: string): ConversationDetail {
  const conversation = getConversation(home.world, id);
  const runs = listRuns(home.world, { conversationId: id, limit: 100 }).reverse();
  const ids = runs.map((run) => run.id);
  return { conversation, runs, receipts: listRunReceipts(home.world, ids), activity: listRunActivity(home.world, ids) };
}

/** Server-Sent Events: replay after the cursor, then follow commits. Live
 * updates (a reply being written) go out as they happen and are never replayed.
 */
function events(home: Home, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const fromHeader = Number(req.headers["last-event-id"]);
  const fromQuery = Number(url.searchParams.get("after"));
  let cursor = Number.isInteger(fromHeader) && fromHeader >= 0 ? fromHeader : Number.isInteger(fromQuery) && fromQuery >= 0 ? fromQuery : latestEventSeq(home.world);
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`retry: 2000\n\n`);
  const flush = () => {
    for (;;) {
      const page = listEvents(home.world, { after: cursor, limit: 500 });
      for (const event of page.events as CoreEvent[]) res.write(`id: ${event.seq}\nevent: core\ndata: ${JSON.stringify(event)}\n\n`);
      cursor = page.cursor;
      if (page.events.length < 500) return;
    }
  };
  flush();
  const unsubscribe = home.world.onCommit(() => setImmediate(() => { if (!res.writableEnded) flush(); }));
  const onLive = (update: LiveUpdate) => { if (!res.writableEnded) res.write(`event: live\ndata: ${JSON.stringify(update)}\n\n`); };
  home.live.on("update", onLive);
  const keepAlive = setInterval(() => res.write(`: keep-alive\n\n`), 25_000);
  req.on("close", () => { unsubscribe(); home.live.off("update", onLive); clearInterval(keepAlive); });
}

function serveFile(res: ServerResponse, uiDir: string, pathname: string): void {
  if (!existsSync(join(uiDir, "index.html"))) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("The interface is not built yet. Run: npm run build:ui\n");
    return;
  }
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(uiDir, relative);
  if (!file.startsWith(uiDir + sep) && file !== uiDir) file = join(uiDir, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) file = join(uiDir, "index.html");
  const hashed = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  createReadStream(file).pipe(res);
}

const LOCAL_ONLY = "Only on the machine Alfred runs on";
const guessKind = (kind: unknown): DeviceKind => (DEVICE_KINDS as readonly unknown[]).includes(kind) ? kind as DeviceKind : "browser";

/** The device list, with which devices get push notifications. */
function withPush<T extends RemoteResponse>(response: T, push: PushService | undefined): T {
  if (!push) return response;
  if (response.local) return { ...response, devices: response.devices.map((device) => ({ ...device, push: push.subscribed(device.id) })) };
  return { ...response, device: { ...response.device, push: push.subscribed(response.device.id) } };
}

/** Push notifications for the device asking (only other devices: this machine shows its own). */
async function pushRoute(push: PushService | undefined, device: Device, req: IncomingMessage, res: ServerResponse, path: string, locale: string): Promise<void> {
  const method = req.method ?? "GET";
  if (!push) throw new HttpError(404, "Not found");
  const info = async (): Promise<PushInfo> => ({ publicKey: await push.publicKey(), subscribed: push.subscribed(device.id) });
  if (method === "GET" && path === "/api/push") return send(res, 200, await info());
  if (method === "POST" && path === "/api/push/subscribe") {
    const body = await readJson<{ subscription?: unknown }>(req);
    push.subscribe(device.id, body.subscription);
    return send(res, 200, await info());
  }
  if (method === "POST" && path === "/api/push/unsubscribe") {
    await readJson(req);
    push.unsubscribe(device.id);
    return send(res, 200, await info());
  }
  if (method === "POST" && path === "/api/push/test") {
    await readJson(req);
    if (!push.subscribed(device.id)) throw new HttpError(409, "Turn notifications on first");
    const zh = locale === "zh";
    return send(res, 200, await push.sendTo({ title: "Alfred", body: zh ? "推送通知能用了。" : "Notifications work.", url: "/", tag: "test" }, [device.id]) satisfies PushResult);
  }
  throw new HttpError(404, "Not found");
}

/** Remote access and devices. True when it answered. */
async function remoteRoute(home: Home, options: ServeOptions, peer: Peer, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? "GET";
  const remote = options.remote;
  const isPush = path === "/api/push" || path.startsWith("/api/push/");
  if (!remote || !(isPush || path === "/api/remote" || path.startsWith("/api/remote/") || path.startsWith("/api/devices/") || path === "/api/pair" || path === "/api/device/forget")) return false;
  if (isPush && peer.local) throw new HttpError(400, "This machine shows notifications itself");
  if (method === "POST" && path === "/api/pair") {
    if (peer.local) throw new HttpError(400, "This machine needs no pairing");
    const body = await readJson<PairRequest>(req);
    if (typeof body.code !== "string" || typeof body.name !== "string") throw new HttpError(400, "code and name are required");
    const { device, token } = remote.pair({ code: body.code, name: body.name, kind: guessKind(body.kind), via: peer.login });
    res.setHeader("Set-Cookie", `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`);
    send(res, 200, { device });
    return true;
  }
  if (!peer.local) {
    if (!peer.device) throw new HttpError(401, "This device is not paired with Alfred yet", "unpaired");
    if (method === "GET" && path === "/api/remote") return send(res, 200, withPush({ local: false, device: peer.device } satisfies RemoteResponse, options.push)), true;
    if (isPush) return await pushRoute(options.push, peer.device, req, res, path, userLocale(home.world)), true;
    if (method === "POST" && path === "/api/device/forget") {
      await readJson(req);
      remote.revoke(peer.device.id);
      res.setHeader("Set-Cookie", `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      return send(res, 200, {}), true;
    }
    throw new HttpError(403, LOCAL_ONLY, "local_only");
  }
  if (method === "GET" && path === "/api/remote") return send(res, 200, withPush(await remote.describe(), options.push) satisfies RemoteResponse), true;
  if (method === "POST" && path === "/api/remote") {
    const body = await readJson<{ enabled?: unknown }>(req);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    return send(res, 200, withPush(await remote.setEnabled(body.enabled), options.push) satisfies RemoteResponse), true;
  }
  if (method === "POST" && path === "/api/remote/pairing") {
    await readJson(req);
    await remote.describe();
    return send(res, 200, remote.newPairing()), true;
  }
  const revoke = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})\/revoke$/.exec(path);
  if (revoke && method === "POST") {
    await readJson(req);
    remote.revoke(revoke[1]);
    return send(res, 200, withPush(await remote.describe(), options.push) satisfies RemoteResponse), true;
  }
  throw new HttpError(404, "Not found");
}

async function route(home: Home, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;
  if (method === "GET" && path === "/api/state") return send(res, 200, state(home));
  if (method === "GET" && path === "/api/events") return events(home, req, res, url);

  if (method === "POST" && path === "/api/runs") {
    const body = await readJson<SubmitRunRequest>(req);
    if (typeof body.requestId !== "string" || typeof body.goal !== "string") throw new HttpError(400, "requestId and goal are required");
    const result = submitRun(home.world, { requestId: body.requestId, goal: body.goal, profile: ASSISTANT_PROFILE, conversationId: body.conversationId, context: body.context });
    home.kick();
    return send(res, result.replayed ? 200 : 202, result);
  }
  const conversation = /^\/api\/conversations\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (conversation && method === "GET") return send(res, 200, conversationDetail(home, conversation[1]));
  if (conversation && method === "POST") {
    const body = await readJson<UpdateConversationRequest>(req);
    if (body.title !== undefined && typeof body.title !== "string") throw new HttpError(400, "title must be text");
    if (body.archived !== undefined && typeof body.archived !== "boolean") throw new HttpError(400, "archived must be true or false");
    if (body.model !== undefined && body.model !== null && typeof body.model !== "string") throw new HttpError(400, "model is provider/model or null");
    if (body.thinking !== undefined && body.thinking !== null && typeof body.thinking !== "string") throw new HttpError(400, "thinking is a level or null");
    return send(res, 200, updateConversation(home.world, conversation[1], { title: body.title, archived: body.archived, model: body.model, thinking: body.thinking }));
  }

  if (method === "GET" && path === "/api/models") {
    return send(res, 200, { models: await home.models() } satisfies ModelsResponse);
  }

  const run = /^\/api\/runs\/([A-Za-z0-9_-]+)(?:\/(cancel|resume|respond|steer))?$/.exec(path);
  if (run && method === "GET" && !run[2]) return send(res, 200, getRun(home.world, run[1]));
  if (run && method === "POST" && run[2] === "steer") {
    const body = await readJson<SteerRequest>(req);
    if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text is required");
    if (!(await home.steer(run[1], body.text))) throw new HttpError(409, "That run is not working right now; send it as a new message", "not_running");
    return send(res, 200, { delivered: true });
  }
  if (run && method === "POST" && run[2] === "respond") {
    const body = await readJson<RespondRequest>(req);
    if (typeof body.requestId !== "string" || typeof body.answer !== "string") throw new HttpError(400, "requestId and answer are required");
    return send(res, 200, answerRequest(home.world, run[1], { requestId: body.requestId, answer: body.answer }));
  }
  if (run && method === "POST" && run[2]) {
    await readJson(req);
    if (run[2] === "cancel") return send(res, 200, requestCancel(home.world, run[1]));
    const resumed = resumeRun(home.world, run[1]);
    home.kick();
    return send(res, 200, resumed);
  }

  const op = /^\/api\/ops\/([a-z][a-z0-9]*\.[a-z][a-z_]*)$/.exec(path);
  if (op && method === "POST") {
    const body = await readJson<OpRequest>(req);
    if (typeof body.requestId !== "string") throw new HttpError(400, "requestId is required");
    return send(res, 200, invokeOp(home.world, home.modules, { op: op[1], requestId: body.requestId, input: body.input }));
  }

  if (method === "POST" && path === "/api/presence") {
    const body = await readJson<PresenceRequest>(req);
    if (typeof body.client !== "string" || (body.kind !== "active" && body.kind !== "away")) throw new HttpError(400, "client and kind (active or away) are required");
    return send(res, 200, reportPresence(home.world, { clientId: body.client, kind: body.kind, ...home.presence }));
  }

  const notice = /^\/api\/notices\/([A-Za-z0-9_-]+)\/(claim|present|acknowledge)$/.exec(path);
  if (notice && method === "POST") {
    const body = await readJson<NoticeRequest>(req);
    if (notice[2] === "acknowledge") return send(res, 200, acknowledgeNotice(home.world, notice[1]));
    if (typeof body.client !== "string") throw new HttpError(400, "client is required");
    return send(res, 200, notice[2] === "claim" ? claimNotice(home.world, notice[1], body.client) : presentNotice(home.world, notice[1], body.client));
  }

  // Preferences that are not secrets (for now, the language). A device command like any other.
  if (method === "POST" && path === "/api/settings") {
    const body = await readJson<SettingsRequest>(req);
    if (typeof body.requestId !== "string" || !body.patch || typeof body.patch !== "object") throw new HttpError(400, "requestId and patch are required");
    const result = withCoreContext({ actor: "user" }, () => runCommand(home.world, { requestId: body.requestId, command: "settings.update", input: body.patch }, () => updateSettings(home.world, body.patch as Record<string, unknown>)));
    return send(res, 200, result.result);
  }

  // The user's decisions on proposals. Accepting runs the steps as Alfred's changes, made on the user's yes.
  const proposal = /^\/api\/proposals\/([A-Za-z0-9_-]{1,64})\/(accept|decline|revise)$/.exec(path);
  if (proposal && method === "POST") {
    const [, id, decision] = proposal;
    const body = await readJson<ReviseRequest>(req);
    if (typeof body.requestId !== "string") throw new HttpError(400, "requestId is required");
    if (decision === "revise" && (typeof body.text !== "string" || !body.text.trim())) throw new HttpError(400, "Say what to change");
    const result = withCoreContext({ actor: "user" }, () => runCommand(home.world, { requestId: body.requestId, command: `proposal.${decision}`, input: { id, text: body.text ?? null } }, () => {
      if (decision === "accept") {
        return { proposal: acceptProposal(home.world, id, (step) => withCoreContext({ actor: "alfred" }, () => applyStep(home.world, home.modules, step))) };
      }
      if (decision === "decline") return { proposal: declineProposal(home.world, id) };
      const superseded = supersedeProposal(home.world, id, body.text);
      const steps = superseded.steps.map((step) => step.preview);
      const goal = userLocale(home.world) === "zh"
        ? `修改你之前的提议「${superseded.title}」：${body.text.trim()}\n原来的提议：${superseded.summary}\n步骤：${steps.join("；")}\n请按修改意见重新提议（用 propose），不要直接改。`
        : `Change your earlier proposal "${superseded.title}": ${body.text.trim()}\nThe proposal was: ${superseded.summary}\nSteps: ${steps.join("; ")}\nPropose again with the change (use propose); do not make the changes directly.`;
      const { run } = submitRun(home.world, { requestId: `${body.requestId}.revise`, goal, profile: ASSISTANT_PROFILE, conversationId: superseded.conversationId ?? undefined });
      return { proposal: superseded, run };
    }));
    if (decision === "revise") home.kick();
    return send(res, 200, { ...result.result, replayed: result.replayed } satisfies ProposalResponse);
  }

  if (path.startsWith("/api/")) throw new HttpError(404, "Not found");
  throw new HttpError(405, "Method not allowed");
}

export interface ServeOptions {
  port: number;
  host?: string;
  uiDir: string;
  log?: (message: string) => void;
  /** Connected Google accounts (`/api/connections`); left out, those routes are 404. */
  google?: GoogleConnections;
  /** Remote access and devices (`/api/remote`, `/api/devices`, `/api/pair`); left out, those routes are 404. */
  remote?: RemoteAccess;
  /** Push notifications to paired devices (`/api/push`). */
  push?: PushService;
}

function dispatch(home: Home, options: ServeOptions, peer: Peer, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const path = url.pathname;
  const answer = async () => {
    if (await remoteRoute(home, options, peer, req, res, path)) return;
    if (!peer.local) {
      if (!peer.device) throw new HttpError(401, "This device is not paired with Alfred yet", "unpaired");
      if (path.startsWith("/api/connections")) throw new HttpError(403, LOCAL_ONLY, "local_only");
      if (path === "/api/events" && options.remote) {
        // Revoking ends the device's stream at once; its reconnect is refused.
        const id = peer.device.id;
        const remote = options.remote;
        const onRevoked = (revoked: string) => { if (revoked === id) res.end(); };
        remote.events.on("revoked", onRevoked);
        req.on("close", () => remote.events.off("revoked", onRevoked));
      }
    }
    const google = options.google;
    if (google && path.startsWith("/api/connections") && await handleConnections(google, req, res, url, options.log)) return;
    await route(home, req, res, url);
  };
  answer().catch((error: unknown) => {
    const { status, body } = statusOf(error);
    if (status >= 500) options.log?.(`${req.method} ${path} failed: ${error instanceof Error ? error.stack : String(error)}`);
    if (!res.headersSent) send(res, status, body);
    else res.end();
  });
}

function serveUi(options: ServeOptions, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if ((req.method !== "GET" && req.method !== "HEAD") || url.pathname.startsWith("/api/")) return false;
  try { serveFile(res, options.uiDir, url.pathname); } catch { send(res, 400, { error: "Bad path" }); }
  return true;
}

/** This machine's listener. `port: 0` picks a free port; the Host check then uses the one actually bound. */
export function createHttpServer(home: Home, options: ServeOptions): Server {
  const server: Server = createServer((req, res) => {
    const port = options.port || (server.address() as AddressInfo | null)?.port || 0;
    if (!hostAllowed(req, port) || !originAllowed(req)) return send(res, 403, { error: "Forbidden host or origin" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (serveUi(options, req, res, url)) return;
    dispatch(home, options, { local: true }, req, res, url);
  });
  return server;
}

/** The listener Tailscale Serve forwards other devices to (bind it to loopback). Nothing here counts as local. */
export function createIngressServer(home: Home, options: ServeOptions & { remote: RemoteAccess }): Server {
  const server: Server = createServer((req, res) => {
    const port = (server.address() as AddressInfo | null)?.port || 0;
    if (!ingressHostAllowed(req, port, options.remote.dnsName) || !originAllowed(req)) return send(res, 403, { error: "Forbidden host or origin" });
    // Serve sets this for tailnet users (and drops any the device sent). Another account's device is refused outright.
    const header = req.headers["tailscale-user-login"];
    const login = typeof header === "string" && header ? header : null;
    if (login && options.remote.owner && login !== options.remote.owner) return send(res, 403, { error: "This Alfred belongs to another Tailscale account", code: "other_account" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (serveUi(options, req, res, url)) return;
    const device = deviceForToken(home.world, cookieToken(req));
    dispatch(home, options, { local: false, device, login }, req, res, url);
  });
  return server;
}
