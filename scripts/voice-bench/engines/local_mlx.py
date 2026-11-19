"""Qwen3-ASR on this Mac (MLX). Reads a JSON job list, prints one JSON line per clip.

    uv run --no-project --with mlx-qwen3-asr==0.4.4 python engines/local_mlx.py <model> <jobs.json>

jobs.json: [{"id": "...", "wav": "/abs/path.wav", "context": "space separated terms or empty"}]
The model is loaded once and warmed up on the first clip, so the times are what a resident service would see.
"""
import json
import sys
import time

from mlx_qwen3_asr import Session


def report_stats() -> None:
    """Last line: peak memory of this process and of MLX's GPU buffers, in MB."""
    import resource
    import mlx.core as mx
    peak = getattr(mx, "get_peak_memory", None) or mx.metal.get_peak_memory
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024  # bytes on macOS
    print(json.dumps({"stats": {"rss_mb": round(rss), "gpu_mb": round(peak() / 1024 / 1024)}}), flush=True)


def main() -> None:
    model, jobs_path = sys.argv[1], sys.argv[2]
    with open(jobs_path, encoding="utf-8") as f:
        jobs = json.load(f)
    session = Session(model=model)
    if jobs:
        session.transcribe(jobs[0]["wav"])  # warm-up: load weights, compile kernels
    for job in jobs:
        start = time.perf_counter()
        try:
            result = session.transcribe(job["wav"], context=job.get("context") or "")
            out = {"id": job["id"], "text": result.text, "language": result.language}
        except Exception as error:  # report and keep going
            out = {"id": job["id"], "error": f"{type(error).__name__}: {error}"}
        out["ms"] = round((time.perf_counter() - start) * 1000)
        print(json.dumps(out, ensure_ascii=False), flush=True)
    report_stats()


if __name__ == "__main__":
    main()
