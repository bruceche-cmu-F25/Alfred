/** Recording page for the voice bake-off: serves record.html on 127.0.0.1 and keeps the clips in ./clips.
 *
 *   node scripts/voice-bench/server.ts      → http://127.0.0.1:4791
 */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { listClips, CLIPS, HERE, validId, type ClipMeta } from "./clips.ts";

const PORT = Number(process.env.PORT ?? 4791);
mkdirSync(CLIPS, { recursive: true });

const STATIC: Record<string, [string, string]> = {
  "/": ["record.html", "text/html; charset=utf-8"],
  "/capture-worklet.js": ["capture-worklet.js", "text/javascript; charset=utf-8"],
};

async function body(req: import("node:http").IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("too large");
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

const server = createServer(async (req, res) => {
  const send = (status: number, data: unknown, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(type === "application/json" ? JSON.stringify(data) : data as Buffer);
  };
  try {
    // Only this Mac, only from its own page.
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "")) return send(403, { error: "host" });
    const url = new URL(req.url ?? "/", "http://x");
    const file = STATIC[url.pathname];
    if (req.method === "GET" && file) return send(200, await readFile(join(HERE, file[0])), file[1]);

    if (url.pathname === "/api/clips" && req.method === "GET") return send(200, await listClips());

    const m = url.pathname.match(/^\/api\/clips\/([^/]+)(\/audio)?$/);
    if (!m || !validId(m[1])) return send(404, { error: "not found" });
    const id = m[1];
    const wav = join(CLIPS, `${id}.wav`);
    const meta = join(CLIPS, `${id}.json`);

    if (m[2]) {
      if (req.method === "GET") return send(200, await readFile(wav), "audio/wav");
      if (req.method === "PUT") {
        const data = await body(req, 20 * 1024 * 1024);
        if (data.subarray(0, 4).toString() !== "RIFF") return send(400, { error: "not a wav" });
        await writeFile(wav, data);
        return send(200, { ok: true, bytes: data.length });
      }
    } else {
      if (req.method === "PUT") {
        const input = JSON.parse((await body(req, 64 * 1024)).toString()) as Partial<ClipMeta>;
        const clip: ClipMeta = {
          id,
          category: ["daily", "mixed", "dev"].includes(input.category ?? "") ? input.category! : "daily",
          ref: String(input.ref ?? "").slice(0, 500),
          terms: Array.isArray(input.terms) ? input.terms.map((term) => String(term).trim()).filter(Boolean).slice(0, 20) : [],
        };
        await writeFile(meta, JSON.stringify(clip, null, 2) + "\n");
        return send(200, clip);
      }
      if (req.method === "DELETE") {
        await rm(wav, { force: true });
        // Keep edited text; only drop the recording.
        return send(200, { ok: true, kept: await stat(meta).then(() => true, () => false) });
      }
    }
    send(405, { error: "method" });
  } catch (error) {
    send(500, { error: String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`voice bench recorder: http://127.0.0.1:${PORT}`));
