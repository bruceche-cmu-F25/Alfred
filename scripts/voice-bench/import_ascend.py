"""Turns a sample of ASCEND (real, spontaneous Mandarin-English speech, CC BY-SA 4.0) into bench clips.

    uv run --no-project --with pyarrow python -I scripts/voice-bench/import_ascend.py <out-dir> <parquet>...

Parquet files: https://huggingface.co/datasets/CAiRE/ASCEND (main/test-*.parquet, main/validation-*.parquet).
Picks up to PER clips of 2.5–12 s for each (speaker, zh|mixed), with a fixed seed. Pure-Chinese clips become
"daily", mixed ones "mixed"; a mixed clip's English words (3+ letters) are its key terms.
"""
import json
import random
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import pyarrow.parquet as pq

PER = 9
FILLERS = {"um", "uh", "er", "erm", "hmm", "mm", "ah", "oh", "eh"}


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    groups = defaultdict(list)
    for path in sys.argv[2:]:
        for row in pq.read_table(path).to_pylist():
            if row["language"] in ("zh", "mixed") and 2.5 <= row["duration"] <= 12:
                groups[(row["original_speaker_id"], row["language"])].append(row)
    rng = random.Random(7)
    count = 0
    for (speaker, language), rows in sorted(groups.items()):
        for row in rng.sample(rows, min(PER, len(rows))):
            clip_id = f"a{'m' if language == 'mixed' else 'z'}{speaker:02d}-{count:03d}"
            count += 1
            audio = row["audio"]["bytes"]
            wav = out / f"{clip_id}.wav"
            # Whatever the stored format, end up with 16 kHz mono 16-bit WAV.
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", "pipe:0", "-ar", "16000", "-ac", "1",
                            "-sample_fmt", "s16", str(wav)], input=audio, check=True)
            ref = row["transcription"].strip()
            terms = sorted({w for w in re.findall(r"[A-Za-z][A-Za-z']{2,}", ref) if w.lower() not in FILLERS})
            meta = {"id": clip_id, "category": "mixed" if language == "mixed" else "daily", "ref": ref, "terms": terms}
            (out / f"{clip_id}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{count} clips → {out}")


if __name__ == "__main__":
    main()
