#!/usr/bin/env python3
"""
Repeatable local benchmark runner for LiveTranslate.

Usage:
  python scripts/benchmark_runner.py --clips-manifest benchmark/clips/manifest.json --runs 3
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional


PRIMARY_PROMPT = (
    'You are a live meeting assistant. Output strict JSON only: '
    '{"translation_tr":"...","reply_en":"...","reply_tr":"...","confidence":0.0}. '
    "Keep technical terms in English when needed. Replies must be concise and actionable."
)


def percentile(values: List[float], ratio: float) -> Optional[float]:
    if not values:
        return None
    sorted_vals = sorted(values)
    idx = max(0, min(len(sorted_vals) - 1, int((len(sorted_vals) * ratio) - 1)))
    return round(sorted_vals[idx], 2)


def summary(values: List[float]) -> Dict[str, Optional[float]]:
    if not values:
        return {"count": 0, "latest": None, "p50": None, "p95": None, "mean": None}
    return {
        "count": len(values),
        "latest": round(values[-1], 2),
        "p50": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "mean": round(statistics.fmean(values), 2),
    }


def load_manifest(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Manifest not found: {path}")
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data.get("clips"), list):
        raise ValueError("Manifest must contain 'clips' array.")
    return data


def transcribe_clip(model: Any, clip_path: Path) -> Dict[str, Any]:
    started = time.perf_counter()
    segments, _ = model.transcribe(
        str(clip_path),
        language="en",
        beam_size=1,
        best_of=1,
        temperature=0.0,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    parts = []
    for segment in segments:
        text = (segment.text or "").strip()
        if text:
            parts.append(text)
    transcript = " ".join(parts).strip()
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return {"text_en": transcript, "latency_ms": round(elapsed_ms, 2)}


def ollama_stream_assist(
    base_url: str, model: str, context_lines: List[str], remote_question: str
) -> Dict[str, Any]:
    payload = {
        "model": model,
        "stream": True,
        "options": {"temperature": 0.2, "num_ctx": 4096},
        "messages": [
            {"role": "system", "content": PRIMARY_PROMPT},
            {
                "role": "user",
                "content": f"Context:\n{chr(10).join(context_lines)}\n\nLatest remote sentence:\n{remote_question}",
            },
        ],
    }

    req = urllib.request.Request(
        url=f"{base_url.rstrip('/')}/api/chat",
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload).encode("utf-8"),
    )

    started = time.perf_counter()
    first_token_ms: Optional[float] = None
    raw = ""

    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    token_payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                token = ((token_payload.get("message") or {}).get("content")) or ""
                if token:
                    raw += token
                    if first_token_ms is None:
                        first_token_ms = (time.perf_counter() - started) * 1000.0
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Ollama request failed: {exc}") from exc

    final_ms = (time.perf_counter() - started) * 1000.0
    return {
        "raw": raw,
        "first_token_ms": round(first_token_ms, 2) if first_token_ms is not None else None,
        "final_ms": round(final_ms, 2),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run repeatable STT + assist benchmarks.")
    parser.add_argument(
        "--clips-manifest",
        default="benchmark/clips/manifest.json",
        help="Path to benchmark clip manifest JSON.",
    )
    parser.add_argument("--runs", type=int, default=3, help="Number of benchmark repetitions.")
    parser.add_argument("--stt-model", default="small.en", help="faster-whisper model name.")
    parser.add_argument(
        "--assist-model",
        default="qwen2.5:7b-instruct-q4_K_M",
        help="Ollama model name for assist generation.",
    )
    parser.add_argument(
        "--ollama-base-url", default="http://127.0.0.1:11434", help="Ollama API base URL."
    )
    parser.add_argument(
        "--out",
        default="benchmark/reports",
        help="Output directory for benchmark report JSON.",
    )
    args = parser.parse_args()

    manifest_path = Path(args.clips_manifest).resolve()
    try:
        manifest = load_manifest(manifest_path)
    except Exception as exc:
        print(f"[benchmark] Failed to load manifest: {exc}", file=sys.stderr)
        return 1

    clips = manifest.get("clips", [])
    if not clips:
        print("[benchmark] No clips found in manifest. Add fixed clips to run benchmarks.")
        return 1

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(
            "[benchmark] faster-whisper not available. Install with: pip install faster-whisper",
            file=sys.stderr,
        )
        print(f"[benchmark] Detail: {exc}", file=sys.stderr)
        return 1

    print(f"[benchmark] Loading STT model: {args.stt_model}")
    model = WhisperModel(args.stt_model, device="cpu", compute_type="int8")

    stt_ms_values: List[float] = []
    assist_first_token_ms_values: List[float] = []
    assist_final_ms_values: List[float] = []
    clip_results: List[Dict[str, Any]] = []

    for run_idx in range(args.runs):
        print(f"[benchmark] Run {run_idx + 1}/{args.runs}")
        for clip in clips:
            clip_id = str(clip.get("id") or f"clip_{run_idx}")
            clip_path = (manifest_path.parent / str(clip.get("audio_path") or "")).resolve()
            if not clip_path.exists():
                print(f"[benchmark] Skip missing clip: {clip_id} -> {clip_path}")
                continue

            stt_result = transcribe_clip(model, clip_path)
            stt_ms_values.append(stt_result["latency_ms"])

            context_lines = clip.get("context_lines") or []
            if not isinstance(context_lines, list):
                context_lines = []
            context_lines = [str(item) for item in context_lines]

            remote_question = stt_result["text_en"] or str(clip.get("reference_text") or "")
            if not remote_question:
                clip_results.append(
                    {
                        "run": run_idx + 1,
                        "clip_id": clip_id,
                        "clip_path": str(clip_path),
                        "stt_latency_ms": stt_result["latency_ms"],
                        "assist_skipped": True,
                        "reason": "no_transcript",
                    }
                )
                continue

            assist_result = ollama_stream_assist(
                args.ollama_base_url,
                args.assist_model,
                context_lines=context_lines,
                remote_question=remote_question,
            )
            if assist_result["first_token_ms"] is not None:
                assist_first_token_ms_values.append(float(assist_result["first_token_ms"]))
            assist_final_ms_values.append(float(assist_result["final_ms"]))

            clip_results.append(
                {
                    "run": run_idx + 1,
                    "clip_id": clip_id,
                    "clip_path": str(clip_path),
                    "stt_latency_ms": stt_result["latency_ms"],
                    "assist_first_token_ms": assist_result["first_token_ms"],
                    "assist_final_ms": assist_result["final_ms"],
                }
            )

    report = {
        "generated_at": dt.datetime.utcnow().isoformat() + "Z",
        "manifest": str(manifest_path),
        "runs": args.runs,
        "stt_model": args.stt_model,
        "assist_model": args.assist_model,
        "ollama_base_url": args.ollama_base_url,
        "summary": {
            "stt_first_chunk_ms": summary(stt_ms_values),
            "assist_first_token_ms": summary(assist_first_token_ms_values),
            "assist_final_ms": summary(assist_final_ms_values),
        },
        "clips": clip_results,
    }

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"benchmark_{dt.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    with out_file.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print("[benchmark] Complete")
    print(f"[benchmark] Report: {out_file}")
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
