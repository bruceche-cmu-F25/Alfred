/** Speech to text on the home node. Every device only records; the words are worked out here, so a phone needs no
 * model, keys never leave this machine, and every device gets the same quality.
 *
 * The model (Qwen3-ASR 0.6B on MLX, see docs/research/voice-input.md §6.1) runs in a worker process that is started
 * when someone starts talking (`warm`), so loading overlaps with the speaking, and stopped after a while unused:
 * it holds about 1.5 GB while loaded and nothing otherwise.
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "voice", "transcribe.py");
export const DEFAULT_VOICE_COMMAND = [
  "uv", "run", "--no-project", "--python", "3.12", "--with", "mlx-qwen3-asr==0.4.4", "python", "-I", WORKER, "Qwen/Qwen3-ASR-0.6B",
];
/** Five minutes of 16 kHz 16-bit mono, and a little. */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

export class VoiceError extends Error {
  readonly code: "unavailable" | "failed" | "busy";
  constructor(code: VoiceError["code"], message: string) { super(message); this.name = "VoiceError"; this.code = code; }
}

export interface Transcript { text: string; ms: number }

export interface TranscriberOptions {
  /** The worker to run (tests pass a fake). Default: Qwen3-ASR through uv. */
  command?: string[];
  /** Unload after this long without use. Default 10 minutes. */
  idleMs?: number;
  /** Give up on one recording after this long (loading included). Default 2 minutes. */
  timeoutMs?: number;
  log?: (message: string) => void;
}

type Pending = { resolve: (t: Transcript) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class Transcriber {
  private readonly command: string[];
  private readonly idleMs: number;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  /** Recordings that have arrived and are not answered yet, counting one still waiting for the model to load. */
  private working = 0;
  private idle: NodeJS.Timeout | null = null;
  private dir: Promise<string> | null = null;
  private seq = 0;
  private reason: Promise<string | null> | null = null;

  constructor(options: TranscriberOptions = {}) {
    this.command = options.command ?? DEFAULT_VOICE_COMMAND;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.log = options.log ?? (() => {});
  }

  /** Why voice cannot work on this machine, or null when it can. */
  unavailable(): Promise<string | null> {
    this.reason ??= (async () => {
      if (this.command !== DEFAULT_VOICE_COMMAND) return null;
      if (process.platform !== "darwin" || process.arch !== "arm64") return "Voice input needs a Mac with Apple silicon";
      const found = await promisify(execFile)("which", ["uv"]).then(() => true, () => false);
      return found ? null : "Voice input needs uv (brew install uv)";
    })();
    return this.reason;
  }

  /** Whether the model is loaded now. */
  get loaded(): boolean { return !!this.child && !!this.ready; }

  /** Start loading the model if it is not loaded; returns at once. */
  warm(): void {
    void this.unavailable().then((why) => { if (!why) void this.start().catch(() => {}); });
    this.touch();
  }

  async transcribe(wav: Buffer, context = ""): Promise<Transcript> {
    const why = await this.unavailable();
    if (why) throw new VoiceError("unavailable", why);
    if (this.pending.size >= 4) throw new VoiceError("busy", "Still working on earlier recordings");
    this.working++;
    try {
      this.dir ??= mkdtemp(join(tmpdir(), "alfred-voice-"));
      const id = String(++this.seq);
      const file = join(await this.dir, `${id}.wav`);
      await writeFile(file, wav);
      try {
        await this.start();
        return await new Promise<Transcript>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new VoiceError("failed", "Transcribing took too long"));
          }, this.timeoutMs);
          this.pending.set(id, { resolve, reject, timer });
          this.child!.stdin.write(JSON.stringify({ id, wav: file, context }) + "\n");
        });
      } finally {
        await rm(file, { force: true });
      }
    } finally {
      this.working--;
      this.touch();
    }
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.stop("closed");
    const dir = this.dir;
    this.dir = null;
    void dir?.then((path) => rm(path, { recursive: true, force: true })).catch(() => {});
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const [command, ...args] = this.command;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    const started = Date.now();
    this.log("voice: loading the speech model");
    this.ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message: { ready?: boolean; id?: string; text?: string; error?: string; ms?: number };
        try { message = JSON.parse(line); } catch { return; }
        if (message.ready) {
          this.log(`voice: model ready in ${Date.now() - started} ms`);
          resolve();
          return;
        }
        const waiting = message.id ? this.pending.get(message.id) : undefined;
        if (!waiting || !message.id) return;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new VoiceError("failed", message.error));
        else waiting.resolve({ text: message.text ?? "", ms: message.ms ?? 0 });
      });
      child.on("error", (error) => reject(new VoiceError("unavailable", `Could not start the speech model: ${error.message}`)));
      child.on("exit", (code) => {
        const why = new VoiceError("failed", `The speech model stopped (${code ?? "signal"}): ${stderr.trim().split("\n").slice(-2).join(" ")}`);
        reject(why);
        if (this.child === child) this.stop(why);
      });
    });
    // A failed start must not stick: the next recording tries again.
    this.ready.catch(() => { if (this.child === child) this.stop("start failed"); });
    return this.ready;
  }

  private stop(reason: string | Error): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(reason instanceof Error ? reason : new VoiceError("failed", `The speech model was stopped (${reason})`));
      this.pending.delete(id);
    }
    if (child && child.exitCode === null) {
      child.kill();
      this.log(`voice: speech model unloaded (${reason instanceof Error ? reason.message : reason})`);
    }
  }

  /** Each use pushes the unload back. */
  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    // Not while a recording is being worked on, even one the model has not been given yet (it is still loading).
    this.idle = setTimeout(() => { if (!this.working) this.stop("idle"); }, this.idleMs);
    this.idle.unref();
  }
}
