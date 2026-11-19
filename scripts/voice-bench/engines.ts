/** The engines under test. Each one turns clips into text; local ones run as a resident process over all clips,
 * cloud ones take one clip per request. Times are from "audio in hand" to "text back", which is what the user
 * waits for after letting go of the key. Cloud times include the upload and, for async APIs, polling. */
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { HERE, RESULTS } from "./clips.ts";

export interface Job { id: string; wav: string; terms: string[] | null }
export interface Result { id: string; text?: string; error?: string; ms: number }
/** What a local engine's process used, in MB. */
export interface Stats { rss_mb: number; gpu_mb: number }

export interface Engine {
  name: string;
  /** Takes a vocabulary list. */
  context: boolean;
  /** US dollars per hour of audio (null when unknown). */
  usdPerHour: number | null;
  note: string;
  /** Why it cannot run here, or null when it can. */
  unavailable(): Promise<string | null>;
  run(jobs: Job[], each: (result: Result) => Promise<void>): Promise<Stats | void>;
}

const env = (name: string) => process.env[name]?.trim() || "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One clip at a time, timed, errors captured. */
async function perClip(jobs: Job[], each: (r: Result) => Promise<void>, one: (job: Job) => Promise<string>) {
  for (const job of jobs) {
    const start = performance.now();
    try {
      const text = await one(job);
      await each({ id: job.id, text, ms: Math.round(performance.now() - start) });
    } catch (error) {
      await each({ id: job.id, error: String((error as Error).message ?? error), ms: Math.round(performance.now() - start) });
    }
  }
}

/** A resident local process that prints one JSON line per clip. */
async function lines(command: string, args: string[], jobs: Job[], each: (r: Result) => Promise<void>): Promise<Stats | void> {
  await mkdir(RESULTS, { recursive: true });
  const jobsFile = join(RESULTS, `.jobs-${process.pid}.json`);
  await writeFile(jobsFile, JSON.stringify(jobs.map((j) => ({ id: j.id, wav: j.wav, context: j.terms?.join(" ") ?? "", terms: j.terms ?? [] }))));
  const child = spawn(command, [...args, jobsFile], { cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  const seen = new Set<string>();
  let stats: Stats | undefined;
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.startsWith("{")) continue;
    const parsed = JSON.parse(line) as Result & { stats?: Stats };
    if (parsed.stats) { stats = parsed.stats; continue; }
    const r = parsed;
    seen.add(r.id);
    await each(r);
  }
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  await rm(jobsFile, { force: true });
  if (code !== 0 && seen.size < jobs.length) throw new Error(`${command} exited ${code}: ${stderr.trim().split("\n").slice(-5).join(" | ")}`);
  return stats;
}

const which = async (cmd: string) => promisify(execFile)("which", [cmd]).then(() => true, () => false);

function qwen(size: "0.6B" | "1.7B"): Engine {
  return {
    name: `qwen3-asr-${size.toLowerCase()}`,
    context: true,
    usdPerHour: 0,
    note: `本机 MLX，mlx-qwen3-asr 0.4.4，Qwen/Qwen3-ASR-${size} fp16；首次运行会从 Hugging Face 下载模型`,
    unavailable: async () => (await which("uv")) ? null : "没有 uv（brew install uv）",
    run: (jobs, each) => lines("uv", ["run", "--no-project", "--python", "3.12", "--with", "mlx-qwen3-asr==0.4.4",
      "python", "-I", "engines/local_mlx.py", `Qwen/Qwen3-ASR-${size}`], jobs, each),
  };
}

const whisper: Engine = {
  name: "whisper-large-v3-turbo",
  context: true,
  usdPerHour: 0,
  note: "本机 MLX，mlx-whisper 0.4.3，mlx-community/whisper-large-v3-turbo；language=zh；繁体转简体后打分；词表放在 initial_prompt；首次运行会下载模型（约 1.6GB）",
  unavailable: async () => (await which("uv")) ? null : "没有 uv（brew install uv）",
  run: (jobs, each) => lines("uv", ["run", "--no-project", "--python", "3.12", "--with", "mlx-whisper==0.4.3",
    "--with", "opencc-python-reimplemented==0.1.7", "python", "-I", "engines/local_whisper.py",
    "mlx-community/whisper-large-v3-turbo"], jobs, each),
};

const APPLE_BIN = join(HERE, "bin", "apple");
const apple: Engine = {
  name: "apple-speechtranscriber",
  context: false,
  usdPerHour: 0,
  note: "本机，macOS 26 SpeechAnalyzer，locale zh-CN；不能给词表",
  async unavailable() {
    if (existsSync(APPLE_BIN)) return null;
    const sdk = await promisify(execFile)("xcrun", ["--show-sdk-version"]).then((r) => r.stdout.trim(), () => "");
    if (!(Number.parseFloat(sdk) >= 26)) {
      return `本机 SDK 是 ${sdk || "未知"}，SpeechAnalyzer 要 macOS 26 SDK：装 Command Line Tools for Xcode 26.x（softwareupdate 里有）或 Xcode 26`;
    }
    await mkdir(join(HERE, "bin"), { recursive: true });
    try {
      await promisify(execFile)("swiftc", ["-O", "-parse-as-library", "-o", APPLE_BIN, join(HERE, "engines", "apple.swift")]);
      return null;
    } catch (error) {
      const msg = String((error as { stderr?: string }).stderr ?? error);
      return `编译失败（engines/apple.swift 还没在 macOS 26 SDK 上编过，可能要修）：${msg.split("\n").slice(0, 3).join(" ")}`;
    }
  },
  run: (jobs, each) => lines(APPLE_BIN, ["zh-CN"], jobs, each),
};

const wavBlob = async (path: string) => new Blob([await readFile(path)], { type: "audio/wav" });

const openai: Engine = {
  name: "openai-gpt-transcribe",
  context: true,
  usdPerHour: 0.27,
  note: "云端，gpt-transcribe，languages[]=zh,en；词表用 keywords[]",
  unavailable: async () => env("OPENAI_API_KEY") ? null : "没有 OPENAI_API_KEY",
  run: (jobs, each) => perClip(jobs, each, async (job) => {
    const form = new FormData();
    form.append("file", await wavBlob(job.wav), "audio.wav");
    form.append("model", "gpt-transcribe");
    form.append("languages[]", "zh");
    form.append("languages[]", "en");
    for (const term of job.terms ?? []) form.append("keywords[]", term);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { authorization: `Bearer ${env("OPENAI_API_KEY")}` }, body: form,
    });
    const data = await res.json() as { text?: string; error?: { message: string } };
    if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
    return data.text ?? "";
  }),
};

const soniox: Engine = {
  name: "soniox-async-v6",
  context: true,
  usdPerHour: 0.10,
  note: "云端，stt-async-v6（文件接口；实时接口 stt-rt-v6 是 $0.12/小时），language_hints zh,en；词表用 context.terms；用完即删",
  unavailable: async () => env("SONIOX_API_KEY") ? null : "没有 SONIOX_API_KEY",
  run: (jobs, each) => perClip(jobs, each, async (job) => {
    const base = "https://api.soniox.com/v1";
    const headers = { authorization: `Bearer ${env("SONIOX_API_KEY")}` };
    const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const res = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.status === 204 ? undefined as T : await res.json() as T;
    };
    const form = new FormData();
    form.append("file", await wavBlob(job.wav), "audio.wav");
    const file = await call<{ id: string }>("/files", { method: "POST", body: form });
    try {
      const body: Record<string, unknown> = { model: "stt-async-v6", file_id: file.id, language_hints: ["zh", "en"] };
      if (job.terms?.length) body.context = { terms: job.terms };
      const t = await call<{ id: string }>("/transcriptions", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      try {
        for (;;) {
          const s = await call<{ status: string; error_message?: string }>(`/transcriptions/${t.id}`);
          if (s.status === "completed") break;
          if (s.status === "error") throw new Error(s.error_message ?? "error");
          await sleep(200);
        }
        return (await call<{ text: string }>(`/transcriptions/${t.id}/transcript`)).text;
      } finally {
        await call(`/transcriptions/${t.id}`, { method: "DELETE" }).catch(() => {});
      }
    } finally {
      await call(`/files/${file.id}`, { method: "DELETE" }).catch(() => {});
    }
  }),
};

const assemblyai: Engine = {
  name: "assemblyai-stt-3-7",
  context: true,
  usdPerHour: 0.21,
  note: "云端，assemblyai-stt-3-7，language_detection（原生混说）；词表用 keyterms_prompt；每秒轮询一次，所以时间偏长；用完即删",
  unavailable: async () => env("ASSEMBLYAI_API_KEY") ? null : "没有 ASSEMBLYAI_API_KEY",
  run: (jobs, each) => perClip(jobs, each, async (job) => {
    const base = "https://api.assemblyai.com/v2";
    const auth = { authorization: env("ASSEMBLYAI_API_KEY") };
    const up = await fetch(`${base}/upload`, { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: await readFile(job.wav) });
    if (!up.ok) throw new Error(`upload: HTTP ${up.status} ${(await up.text()).slice(0, 200)}`);
    const { upload_url } = await up.json() as { upload_url: string };
    const body: Record<string, unknown> = { audio_url: upload_url, speech_models: ["assemblyai-stt-3-7"], language_detection: true };
    if (job.terms?.length) body.keyterms_prompt = job.terms;
    const created = await fetch(`${base}/transcript`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    const t = await created.json() as { id: string; error?: string };
    if (!created.ok) throw new Error(t.error ?? `HTTP ${created.status}`);
    try {
      for (;;) {
        await sleep(1000);
        const s = await (await fetch(`${base}/transcript/${t.id}`, { headers: auth })).json() as { status: string; text?: string; error?: string };
        if (s.status === "completed") return s.text ?? "";
        if (s.status === "error") throw new Error(s.error ?? "error");
      }
    } finally {
      await fetch(`${base}/transcript/${t.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }
  }),
};

const doubao: Engine = {
  name: "doubao-flash",
  context: true,
  usdPerHour: null,
  note: "云端，火山引擎 大模型录音文件识别极速版（bigmodel）；词表用 corpus.context 的 hotwords（极速版文档没写，可能被忽略）",
  unavailable: async () => env("VOLC_API_KEY") || (env("VOLC_APP_KEY") && env("VOLC_ACCESS_KEY")) ? null : "没有 VOLC_API_KEY（或 VOLC_APP_KEY + VOLC_ACCESS_KEY）",
  run: (jobs, each) => perClip(jobs, each, async (job) => {
    const keys: Record<string, string> = env("VOLC_API_KEY")
      ? { "X-Api-Key": env("VOLC_API_KEY") }
      : { "X-Api-App-Key": env("VOLC_APP_KEY"), "X-Api-Access-Key": env("VOLC_ACCESS_KEY") };
    const request: Record<string, unknown> = { model_name: "bigmodel", enable_itn: true, enable_punc: true };
    if (job.terms?.length) request.corpus = { context: JSON.stringify({ hotwords: job.terms.map((word) => ({ word })) }) };
    const res = await fetch("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash", {
      method: "POST",
      headers: {
        ...keys, "content-type": "application/json",
        "X-Api-Resource-Id": "volc.bigasr.auc_turbo", "X-Api-Request-Id": randomUUID(), "X-Api-Sequence": "-1",
      },
      body: JSON.stringify({
        user: { uid: "voice-bench" },
        audio: { data: (await readFile(job.wav)).toString("base64"), format: "wav" },
        request,
      }),
    });
    const status = res.headers.get("x-api-status-code");
    const text = await res.text();
    if (status !== "20000000") throw new Error(`status ${status ?? res.status} ${res.headers.get("x-api-message") ?? ""} ${text.slice(0, 200)}`);
    return (JSON.parse(text) as { result?: { text?: string } }).result?.text ?? "";
  }),
};

export const ENGINES: Engine[] = [qwen("0.6B"), qwen("1.7B"), whisper, apple, soniox, assemblyai, openai, doubao];
