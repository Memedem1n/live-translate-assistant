#!/usr/bin/env python3
"""
Run the agreed latency-focused model sweep and produce a summary report.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Tuple


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_combo(value: str) -> Tuple[str, str]:
    if ":" not in value:
        raise ValueError(f"Invalid combo format: {value} (expected stt_model:assist_model)")
    stt_model, assist_model = value.split(":", 1)
    stt_model = stt_model.strip()
    assist_model = assist_model.strip()
    if not stt_model or not assist_model:
        raise ValueError(f"Invalid combo format: {value}")
    return stt_model, assist_model


def run_combo(
    combo: Tuple[str, str],
    manifest: Path,
    runs: int,
    warmup_runs: int,
    out_dir: Path,
    stt_device: str,
) -> Path:
    stt_model, assist_model = combo
    before = sorted(out_dir.glob("benchmark_*.json"))

    cmd = [
        sys.executable,
        "scripts/benchmark_runner.py",
        "--clips-manifest",
        str(manifest),
        "--runs",
        str(runs),
        "--warmup-runs",
        str(warmup_runs),
        "--stt-model",
        stt_model,
        "--assist-model",
        assist_model,
        "--stt-device",
        stt_device,
        "--out",
        str(out_dir),
    ]

    print(f"[sweep] running: stt={stt_model}, assist={assist_model}")
    subprocess.run(cmd, check=True)

    after = sorted(out_dir.glob("benchmark_*.json"))
    new_files = [path for path in after if path not in before]
    if not new_files:
        raise RuntimeError("No benchmark report produced for combo.")
    return new_files[-1]


def get_metric(report: dict, path: List[str]) -> float | None:
    current = report
    for key in path:
        current = current.get(key, {})
    if isinstance(current, (int, float)):
        return float(current)
    return None


def combo_default_matrix() -> List[Tuple[str, str]]:
    return [
        ("small.en", "qwen2.5:7b-instruct-q4_K_M"),
        ("medium.en", "qwen2.5:7b-instruct-q4_K_M"),
        ("large-v3", "qwen2.5:7b-instruct-q4_K_M"),
        ("small.en", "qwen2.5:3b-instruct-q4_K_M"),
        ("small.en", "qwen2.5:14b-instruct-q4_K_M"),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run model sweep for latency demo decisions.")
    parser.add_argument(
        "--manifest",
        default="artifacts/bench_clips/manifest.json",
        help="Benchmark clips manifest path.",
    )
    parser.add_argument("--runs", type=int, default=3, help="Runs per combo.")
    parser.add_argument(
        "--warmup-runs",
        type=int,
        default=1,
        help="Initial runs treated as cold-start. Gate uses warm runs only.",
    )
    parser.add_argument(
        "--combo",
        action="append",
        default=[],
        help="Custom combo in 'stt_model:assist_model' format. Repeat for multiple combos.",
    )
    parser.add_argument(
        "--stt-device",
        default="auto",
        choices=["auto", "cuda", "cpu"],
        help="Whisper device strategy forwarded to benchmark_runner.",
    )
    parser.add_argument("--target-stt-ms", type=float, default=800.0)
    parser.add_argument("--target-first-token-ms", type=float, default=900.0)
    parser.add_argument("--target-assist-final-ms", type=float, default=2500.0)
    parser.add_argument(
        "--out-dir",
        default="benchmark/reports",
        help="Output report directory.",
    )
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    if not manifest_path.exists():
        print(f"[sweep] Manifest not found: {manifest_path}", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    combos = [parse_combo(value) for value in args.combo] if args.combo else combo_default_matrix()
    results: List[Dict[str, object]] = []
    failures: List[Dict[str, str]] = []

    for combo in combos:
        try:
            report_path = run_combo(
                combo=combo,
                manifest=manifest_path,
                runs=args.runs,
                warmup_runs=args.warmup_runs,
                out_dir=out_dir,
                stt_device=args.stt_device,
            )
            report = read_json(report_path)
        except Exception as exc:
            failures.append(
                {
                    "stt_model": combo[0],
                    "assist_model": combo[1],
                    "error": str(exc),
                }
            )
            continue

        warm_stt_p50 = get_metric(report, ["summary", "warm_gate", "stt_first_chunk_ms", "p50"])
        warm_first_token_p50 = get_metric(
            report, ["summary", "warm_gate", "assist_first_token_ms", "p50"]
        )
        warm_assist_final_p50 = get_metric(report, ["summary", "warm_gate", "assist_final_ms", "p50"])

        stt_p50 = (
            warm_stt_p50
            if warm_stt_p50 is not None
            else get_metric(report, ["summary", "stt_first_chunk_ms", "p50"])
        )
        first_token_p50 = (
            warm_first_token_p50
            if warm_first_token_p50 is not None
            else get_metric(report, ["summary", "assist_first_token_ms", "p50"])
        )
        assist_final_p50 = (
            warm_assist_final_p50
            if warm_assist_final_p50 is not None
            else get_metric(report, ["summary", "assist_final_ms", "p50"])
        )

        cold_stt_p50 = get_metric(report, ["summary", "cold_start", "stt_first_chunk_ms", "p50"])
        cold_first_token_p50 = get_metric(
            report, ["summary", "cold_start", "assist_first_token_ms", "p50"]
        )
        cold_assist_final_p50 = get_metric(
            report, ["summary", "cold_start", "assist_final_ms", "p50"]
        )

        pass_gate = bool(
            stt_p50 is not None
            and first_token_p50 is not None
            and assist_final_p50 is not None
            and stt_p50 <= args.target_stt_ms
            and first_token_p50 <= args.target_first_token_ms
            and assist_final_p50 <= args.target_assist_final_ms
        )

        results.append(
            {
                "stt_model": combo[0],
                "assist_model": combo[1],
                "report_path": str(report_path),
                "stt_p50_ms": stt_p50,
                "assist_first_token_p50_ms": first_token_p50,
                "assist_final_p50_ms": assist_final_p50,
                "warm_stt_p50_ms": warm_stt_p50,
                "warm_assist_first_token_p50_ms": warm_first_token_p50,
                "warm_assist_final_p50_ms": warm_assist_final_p50,
                "cold_stt_p50_ms": cold_stt_p50,
                "cold_assist_first_token_p50_ms": cold_first_token_p50,
                "cold_assist_final_p50_ms": cold_assist_final_p50,
                "pass_latency_gate": pass_gate,
            }
        )

    passing = [item for item in results if item["pass_latency_gate"]]
    sorted_by_speed = sorted(
        results,
        key=lambda item: (
            float(item["assist_first_token_p50_ms"] or 1e9),
            float(item["assist_final_p50_ms"] or 1e9),
            float(item["stt_p50_ms"] or 1e9),
        ),
    )

    final = {
        "generated_at": dt.datetime.utcnow().isoformat() + "Z",
        "manifest": str(manifest_path),
        "warmup_runs": args.warmup_runs,
        "targets": {
            "stt_p50_ms": args.target_stt_ms,
            "assist_first_token_p50_ms": args.target_first_token_ms,
            "assist_final_p50_ms": args.target_assist_final_ms,
        },
        "results": results,
        "failures": failures,
        "fastest_candidate": sorted_by_speed[0] if sorted_by_speed else None,
        "passing_candidates": passing,
        "recommendation": (
            "Use fastest passing candidate and verify response quality manually on live demo."
            if passing
            else "No candidate passed latency gate. Apply tuning (context reduction, shorter replies, lower num_ctx)."
        ),
    }

    out_path = out_dir / f"sweep_{dt.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    out_path.write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[sweep] results: {out_path}")
    print(json.dumps(final, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
