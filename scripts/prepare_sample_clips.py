#!/usr/bin/env python3
"""
Download ready-to-use public sample clips and build a benchmark manifest.

This script writes under artifacts/ so the repository stays clean.
"""

from __future__ import annotations

import argparse
import json
import shutil
import urllib.request
from pathlib import Path

SAMPLE_SOURCES = [
    {
        "id": "sr_english",
        "url": "https://raw.githubusercontent.com/Uberi/speech_recognition/master/examples/english.wav",
        "reference_text": "Please call Stella. Ask her to bring these things with her from the store.",
    },
    {
        "id": "sr_chinese",
        "url": "https://raw.githubusercontent.com/Uberi/speech_recognition/master/examples/chinese.flac",
        "reference_text": "",
    },
    {
        "id": "sr_french",
        "url": "https://raw.githubusercontent.com/Uberi/speech_recognition/master/examples/french.aiff",
        "reference_text": "",
    },
    {
        "id": "whisper_jfk",
        "url": "https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac",
        "reference_text": "And so my fellow Americans, ask not what your country can do for you.",
    },
    {
        "id": "whispercpp_jfk",
        "url": "https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/samples/jfk.wav",
        "reference_text": "Ask not what your country can do for you.",
    },
    {
        "id": "vosk_test",
        "url": "https://raw.githubusercontent.com/alphacep/vosk-api/master/python/example/test.wav",
        "reference_text": "",
    },
    {
        "id": "deepspeech_ldc93s1",
        "url": "https://raw.githubusercontent.com/mozilla/DeepSpeech/master/data/smoke_test/LDC93S1.wav",
        "reference_text": "She had your dark suit in greasy wash water all year.",
    },
    {
        "id": "deepspeech_new_home",
        "url": "https://raw.githubusercontent.com/mozilla/DeepSpeech/master/data/smoke_test/new-home-in-the-stars-16k.wav",
        "reference_text": "",
    },
]


def download_file(url: str, destination: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Interview-Copilot-Benchmark-Prep/1.0",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        with destination.open("wb") as output:
            shutil.copyfileobj(response, output)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare sample benchmark clips.")
    parser.add_argument(
        "--out-dir",
        default="artifacts/bench_clips",
        help="Directory where clips and manifest will be created.",
    )
    args = parser.parse_args()

    out_dir = Path(args.out_dir).resolve()
    clips_dir = out_dir / "clips"
    manifest_path = out_dir / "manifest.json"
    clips_dir.mkdir(parents=True, exist_ok=True)

    manifest_clips = []
    for sample in SAMPLE_SOURCES:
        extension = Path(sample["url"]).suffix or ".wav"
        filename = f"{sample['id']}{extension}"
        destination = clips_dir / filename
        print(f"[clips] downloading {sample['id']} -> {destination.name}")
        download_file(sample["url"], destination)

        manifest_clips.append(
            {
                "id": sample["id"],
                "audio_path": f"clips/{filename}",
                "reference_text": sample["reference_text"],
                "context_lines": [
                    "[remote] Could you summarize the previous topic quickly?",
                    "[self] Sure, I will provide a concise summary.",
                ],
            }
        )

    manifest = {
        "version": 1,
        "description": "Prepared public sample set for latency/quality smoke benchmarks.",
        "clips": manifest_clips,
    }

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[clips] ready: {manifest_path}")
    print(f"[clips] total clips: {len(manifest_clips)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

