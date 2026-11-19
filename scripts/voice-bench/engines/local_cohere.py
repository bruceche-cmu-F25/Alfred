"""Cohere Transcribe on this Mac, through mlx-speech (int8 MLX weights). Same job format and output as local_mlx.py.

    uv run --no-project --python 3.13 --with mlx-speech==0.5.6 python engines/local_cohere.py <hf-repo> <language> <jobs.json>

Cohere Transcribe takes one language per request and no vocabulary, so there is no context.
"""
import json
import sys
import time
import wave

import numpy as np


def report_stats() -> None:
    """Last line: peak memory of this process and of MLX's GPU buffers, in MB."""
    import resource
    import mlx.core as mx
    peak = getattr(mx, "get_peak_memory", None) or mx.metal.get_peak_memory
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024  # bytes on macOS
    print(json.dumps({"stats": {"rss_mb": round(rss), "gpu_mb": round(peak() / 1024 / 1024)}}), flush=True)


def read_wav(path: str) -> np.ndarray:
    """16-bit mono WAV (what the bench stores) as float32 in [-1, 1]."""
    with wave.open(path) as w:
        assert w.getsampwidth() == 2 and w.getnchannels() == 1 and w.getframerate() == 16000, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def main() -> None:
    from huggingface_hub import snapshot_download
    from mlx_speech.generation import CohereAsrModel

    repo, language, jobs_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(jobs_path, encoding="utf-8") as f:
        jobs = json.load(f)
    # "owner/repo:subdir" for repositories that keep the weights in a folder.
    name, _, subdir = repo.partition(":")
    root = snapshot_download(name)
    model = CohereAsrModel.from_path(f"{root}/{subdir}" if subdir else root)
    run = lambda wav: model.transcribe(read_wav(wav), sample_rate=16000, language=language, punctuation=True).text.strip()
    if jobs:
        run(jobs[0]["wav"])  # warm-up
    for job in jobs:
        start = time.perf_counter()
        try:
            out = {"id": job["id"], "text": run(job["wav"])}
        except Exception as error:  # report and keep going
            out = {"id": job["id"], "error": f"{type(error).__name__}: {error}"}
        out["ms"] = round((time.perf_counter() - start) * 1000)
        print(json.dumps(out, ensure_ascii=False), flush=True)
    report_stats()


if __name__ == "__main__":
    main()
