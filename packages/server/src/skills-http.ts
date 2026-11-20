/** `/api/skills/*`: Alfred's skills (see @alfred/protocol). The host and origin checks of http.ts have already run,
 * and only this machine reaches these routes. Errors are thrown; http.ts turns a SkillError into its status.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Skills } from "@alfred/engine-pi";
import type { SkillSearchResponse } from "@alfred/protocol";

const MAX_BODY = 16 * 1024;
const refuse = (status: number, message: string) => Object.assign(new Error(message), { name: "SkillError", code: status === 404 ? "not_found" : "invalid" });

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw refuse(400, "Send JSON");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw refuse(400, "Request too large");
    chunks.push(chunk as Buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw refuse(400, "Invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refuse(400, "Invalid JSON");
  return value as Record<string, unknown>;
}
const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > 2000) throw refuse(400, `${key} is required`);
  return value;
};

/** Handles the request when it is one of the skills routes; false when it is not. */
export async function handleSkills(skills: Skills, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (method === "GET" && path === "/api/skills") return send(res, 200, skills.list()), true;
  if (method === "GET" && path === "/api/skills/content") {
    const id = url.searchParams.get("id");
    if (!id) throw refuse(400, "id is required");
    return send(res, 200, skills.content(id)), true;
  }
  if (method !== "POST") return false;
  const action = /^\/api\/skills\/(enable|disable|remove|add|search|updates|update)$/.exec(path)?.[1];
  if (!action) return false;
  const body = await readJson(req);
  if (action === "enable" || action === "disable") return send(res, 200, skills.setEnabled(text(body, "id"), action === "enable")), true;
  if (action === "remove") { skills.remove(text(body, "id")); return send(res, 200, {}), true; }
  if (action === "add") return send(res, 200, typeof body.package === "string" ? await skills.install(text(body, "package")) : skills.addFound(text(body, "path"))), true;
  if (action === "search") return send(res, 200, { results: await skills.search(text(body, "query")) } satisfies SkillSearchResponse), true;
  if (action === "updates") return send(res, 200, await skills.updates()), true;
  return send(res, 200, await skills.update(text(body, "id"))), true;
}
