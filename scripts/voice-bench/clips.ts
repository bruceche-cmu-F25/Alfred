/** The clips: prompts.json gives the 30 starting lines; clips/<id>.json overrides a line once edited, clips/<id>.wav is the recording. */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
/** Overridable so a test run can use its own folders. */
export const CLIPS = process.env.VOICE_BENCH_CLIPS || join(HERE, "clips");
export const RESULTS = process.env.VOICE_BENCH_RESULTS || join(HERE, "results");

export type Category = "daily" | "mixed" | "dev";
export interface ClipMeta { id: string; category: Category; ref: string; terms: string[] }
export interface Clip extends ClipMeta { recorded: boolean; seconds: number }

export const validId = (id: string) => /^[a-z0-9-]{1,32}$/.test(id);

/** Seconds of audio in a 16-bit PCM WAV (reads the header, not the whole file). */
export function wavSeconds(wav: Buffer): number {
  const rate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const bits = wav.readUInt16LE(34);
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return Math.min(size, wav.length - offset - 8) / (rate * channels * (bits / 8));
    offset += 8 + size + (size % 2);
  }
  return 0;
}

export async function listClips(): Promise<Clip[]> {
  const prompts = JSON.parse(await readFile(join(HERE, "prompts.json"), "utf8")) as ClipMeta[];
  const files = await readdir(CLIPS).catch(() => [] as string[]);
  const byId = new Map(prompts.map((p) => [p.id, p]));
  for (const name of files.filter((f) => f.endsWith(".json"))) {
    const meta = JSON.parse(await readFile(join(CLIPS, name), "utf8")) as ClipMeta;
    if (validId(meta.id)) byId.set(meta.id, meta);
  }
  const clips: Clip[] = [];
  for (const meta of byId.values()) {
    const wav = files.includes(`${meta.id}.wav`) ? await readFile(join(CLIPS, `${meta.id}.wav`)) : null;
    clips.push({ ...meta, recorded: !!wav, seconds: wav ? wavSeconds(wav) : 0 });
  }
  return clips.sort((a, b) => a.id.localeCompare(b.id));
}
