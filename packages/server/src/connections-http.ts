/** `/api/connections/*`: connected accounts and model sign-in (see @alfred/protocol). The host and
 * origin checks of http.ts have already run, and only this machine reaches these routes. Nothing here
 * returns a secret.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ModelSignInError, type ModelAccounts } from "@alfred/engine-pi";
import type { ConnectionsResponse, GoogleConnectRequest } from "@alfred/protocol";
import { GoogleError, isGoogleCapability, type GoogleConnections } from "./google.ts";

const MAX_BODY = 16 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw Object.assign(new Error("Send JSON"), { status: 415 });
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  return value as Record<string, unknown>;
}

const ACCOUNT = /^\/api\/connections\/google\/([^/]{3,200})\/(disable|disconnect|check)$/;
const FLOW = /^\/api\/connections\/flows\/([A-Za-z0-9_-]{1,32})(\/cancel)?$/;
const MODEL_PROVIDER = /^\/api\/connections\/models\/([a-z0-9][a-z0-9._-]{0,63})\/(login|logout)$/;
const MODEL_FLOW = /^\/api\/connections\/models\/flows\/([A-Za-z0-9_-]{1,32})(?:\/(answer|cancel))?$/;

/** What the connections routes can reach; each part's routes are 404 without it. */
export interface Connections { google?: GoogleConnections; models?: ModelAccounts }

/** Model sign-in: providers, signing in and out, importing keys from Pi. */
async function modelRoutes(models: ModelAccounts, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? "GET";
  if (method === "GET" && path === "/api/connections/models") return send(res, 200, await models.describe()), true;
  if (method === "POST" && path === "/api/connections/models/import") {
    const body = await readJson(req);
    const providers = Array.isArray(body.providers) ? body.providers.filter((item): item is string => typeof item === "string") : [];
    return send(res, 200, await models.importFromPi(providers)), true;
  }
  const flow = MODEL_FLOW.exec(path);
  if (flow) {
    const [, id, action] = flow;
    if (method === "GET" && !action) {
      const state = models.flow(id);
      return send(res, state ? 200 : 404, state ?? { error: "No such sign-in (finished long ago, or the home node restarted)" }), true;
    }
    if (method === "POST" && action === "answer") {
      const body = await readJson(req);
      if (typeof body.promptId !== "string" || typeof body.value !== "string") return send(res, 400, { error: "promptId and value are required" }), true;
      return send(res, 200, models.answer(id, body.promptId, body.value)), true;
    }
    if (method === "POST" && action === "cancel") {
      await readJson(req);
      const state = models.cancel(id);
      return send(res, state ? 200 : 404, state ?? { error: "No such sign-in" }), true;
    }
  }
  const provider = MODEL_PROVIDER.exec(path);
  if (provider && method === "POST") {
    const body = await readJson(req);
    if (provider[2] === "logout") return send(res, 200, await models.logout(provider[1])), true;
    if (body.method !== "oauth" && body.method !== "api_key") return send(res, 400, { error: "method is oauth or api_key" }), true;
    return send(res, 200, await models.start(provider[1], body.method)), true;
  }
  return false;
}

/** Handles the request when it is under /api/connections; false when it is not. */
export async function handleConnections(services: Connections, req: IncomingMessage, res: ServerResponse, url: URL, log?: (message: string) => void): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/connections")) return false;
  const method = req.method ?? "GET";
  const { google, models } = services;
  try {
    if (path.startsWith("/api/connections/models")) {
      if (models && await modelRoutes(models, req, res, path)) return true;
      send(res, 404, { error: "Not found" });
      return true;
    }
    if (!google) {
      send(res, 404, { error: "Not found" });
      return true;
    }
    if (method === "GET" && path === "/api/connections") {
      send(res, 200, { google: google.status() } satisfies ConnectionsResponse);
      return true;
    }
    if (method === "POST" && path === "/api/connections/google/connect") {
      const body = (await readJson(req)) as Partial<GoogleConnectRequest>;
      const capabilities = Array.isArray(body.capabilities) ? body.capabilities : [];
      if (!capabilities.every(isGoogleCapability)) return send(res, 400, { error: "Unknown capability" }), true;
      if (body.account !== undefined && typeof body.account !== "string") return send(res, 400, { error: "account is an email" }), true;
      send(res, 200, { flow: await google.start({ capabilities, account: body.account }) });
      return true;
    }
    const flow = FLOW.exec(path);
    if (flow && (method === "GET" ? !flow[2] : method === "POST" && !!flow[2])) {
      if (method === "POST") await readJson(req);
      const status = flow[2] ? google.cancel(flow[1]) : google.flow(flow[1]);
      send(res, status ? 200 : 404, status ?? { error: "No such sign-in (finished long ago, or the home node restarted)" });
      return true;
    }
    const account = ACCOUNT.exec(path);
    if (account) {
      const email = decodeURIComponent(account[1]);
      const action = account[2];
      if (action === "check" && method === "GET") return send(res, 200, await google.check(email)), true;
      if (method === "POST" && action === "disable") {
        const body = await readJson(req);
        if (!isGoogleCapability(body.capability)) return send(res, 400, { error: "Unknown capability" }), true;
        send(res, 200, google.disable(email, body.capability));
        return true;
      }
      if (method === "POST" && action === "disconnect") {
        await readJson(req);
        send(res, 200, await google.disconnect(email));
        return true;
      }
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof ModelSignInError) {
      const status = error.code === "unknown_provider" || error.code === "missing" ? 404 : error.code === "busy" || error.code === "state" ? 409 : 400;
      send(res, status, { error: error.message, code: error.code });
    } else if (error instanceof GoogleError) {
      const status = error.code === "unknown_account" ? 404 : error.code === "no_client" ? 409 : error.code === "busy" ? 429 : 502;
      send(res, status, { error: error.message, code: error.code });
    } else if (error instanceof SyntaxError) {
      send(res, 400, { error: "Invalid JSON" });
    } else {
      const status = (error as { status?: number }).status;
      if (!res.headersSent) send(res, status ?? 500, { error: status ? (error as Error).message : "Internal error" });
      if (!status) log?.(`${method} ${path} failed: ${error instanceof Error ? error.stack : String(error)}`);
    }
  }
  return true;
}
