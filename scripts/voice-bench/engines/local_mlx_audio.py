"""Speech models run through mlx-audio (used here for Cohere Transcribe). Same job format and output as local_mlx.py.

    uv run --no-project --with mlx-audio==0.6.6 python engines/local_mlx_audio.py <hf-repo> <language> <jobs.json>

Cohere Transcribe takes one language per request and no vocabulary, so there is no context.
"""
import json
import sys
import time


def report_stats() -> None:
    """Last line: peak memory of this process and of MLX's GPU buffers, in MB."""
    import resource
    import mlx.core as mx
    peak = getattr(mx, "get_peak_memory", None) or mx.metal.get_peak_memory
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024  # bytes on macOS
    print(json.dumps({"stats": {"rss_mb": round(rss), "gpu_mb": round(peak() / 1024 / 1024)}}), flush=True)


def main() -> None:
    from mlx_audio.stt import load

    repo, language, jobs_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(jobs_path, encoding="utf-8") as f:
        jobs = json.load(f)
    model = load(repo)
    run = lambda wav: model.generate(wav, language=language).text.strip()
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
