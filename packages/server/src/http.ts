/** The client protocol over HTTP (see @alfred/protocol), plus the UI's files.
 *
 * Step 1 is local only: the server binds to loopback and accepts requests only
 * for a loopback Host (DNS-rebinding defence) and, when a browser sends an
 * Origin, only from itself. Paired devices and their tokens come with
 * multi-device support.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import {
  AREAS, acceptProposal, declineProposal, getSettings, listOpenProposals, supersedeProposal, runCommand, updateSettings, userLocale, withCoreContext,
  acknowledgeNotice, answerRequest, claimNotice, getConversation, getRun, latestEventSeq, listConversations, listEvents, listNotices,
  listRunActivity, listRunReceipts, listRuns, presentNotice, reportPresence, requestCancel, resumeRun, submitRun, updateConversation,
  type LiveUpdate,
} from "@alfred/core";
import { applyStep, invokeOp } from "@alfred/module-kit";
import type {
  ConversationDetail, CoreEvent, ErrorResponse, ModelsResponse, NoticeRequest, OpRequest, PresenceRequest, ProposalRequest, ProposalResponse,
  RespondRequest, ReviseRequest, SettingsRequest, StateResponse, SteerRequest, SubmitRunRequest, UpdateConversationRequest,
} from "@alfred/protocol";
import { PROTOCOL_VERSION } from "@alfred/protocol";
import { ASSISTANT_PROFILE, type Home } from "./home.ts";
import { handleConnections } from "./connections-http.ts";
import type { GoogleConnections } from "./google.ts";

const MAX_BODY = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
};

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
}

/** `port: 0` picks a free port; the Host check then uses the one actually bound. */
export function createHttpServer(home: Home, options: ServeOptions): Server {
  const server: Server = createServer((req, res) => {
    const port = options.port || (server.address() as AddressInfo | null)?.port || 0;
    if (!hostAllowed(req, port) || !originAllowed(req)) return send(res, 403, { error: "Forbidden host or origin" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) {
      try { return serveFile(res, options.uiDir, url.pathname); } catch { return send(res, 400, { error: "Bad path" }); }
    }
    const google = options.google;
    const handled = google && url.pathname.startsWith("/api/connections") ? handleConnections(google, req, res, url, options.log) : Promise.resolve(false);
    handled.then((done) => (done ? undefined : route(home, req, res, url))).catch((error: unknown) => {
      const { status, body } = statusOf(error);
      if (status >= 500) options.log?.(`${req.method} ${url.pathname} failed: ${error instanceof Error ? error.stack : String(error)}`);
      if (!res.headersSent) send(res, status, body);
      else res.end();
    });
  });
  return server;
}
