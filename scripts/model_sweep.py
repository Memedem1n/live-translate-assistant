#!/usr/bin/env python3
"""Run the Interview Copilot benchmark sweep and produce a recommendation."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_combo(value: str) -> tuple[str, str]:
    if ":" not in value:
        raise ValueError(f"Invalid combo format: {value}")
    stt_model, assist_model = value.split(":", 1)
    stt_model = stt_model.strip()
    assist_model = assist_model.strip()
    if not stt_model or not assist_model:
        raise ValueError(f"Invalid combo format: {value}")
    return stt_model, assist_model


def combo_default_matrix() -> list[tuple[str, str]]:
    return [
        ("large-v3-turbo", "llama3.1:8b-instruct-q4_K_M"),
        ("large-v3-turbo", "qwen2.5:7b-instruct-q4_K_M"),
    ]


def get_metric(report: dict[str, Any], path: list[str]) -> float | None:
    current: Any = report
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return float(current) if isinstance(current, (int, float)) else None


def run_combo(
    *,
    combo: tuple[str, str],
    manifest: Path | None,
    prompt_suite: Path | None,
    runs: int,
    warmup_runs: int,
    out_dir: Path,
    stt_device: str,
    provider_kind: str,
    base_url: str,
    api_key_env: str,
    backend_label: str,
    target_stt_ms: float,
    target_first_token_ms: float,
    target_assist_final_ms: float,
) -> Path:
    stt_model, assist_model = combo
    before = sorted(out_dir.glob("benchmark_*.json"))
    cmd = [
        sys.executable,
        "scripts/benchmark_runner.py",
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
        "--provider-kind",
        provider_kind,
        "--base-url",
        base_url,
        "--api-key-env",
        api_key_env,
        "--backend-label",
        backend_label,
        "--target-stt-ms",
        str(target_stt_ms),
        "--target-first-token-ms",
        str(target_first_token_ms),
        "--target-final-ms",
        str(target_assist_final_ms),
        "--out",
        str(out_dir),
    ]
    if manifest is not None:
        cmd.extend(["--clips-manifest", str(manifest)])
    if prompt_suite is not None:
        cmd.extend(["--prompt-suite", str(prompt_suite)])
    print(f"[sweep] running combo stt={stt_model} assist={assist_model} provider={provider_kind}")
    subprocess.run(cmd, check=True)
    after = sorted(out_dir.glob("benchmark_*.json"))
    new_files = [path for path in after if path not in before]
    if not new_files:
        raise RuntimeError("No benchmark report produced for combo.")
    return new_files[-1]


def weighted_score(result: dict[str, Any]) -> float:
    ttft = float(result.get("assist_first_token_p50_ms") or 1e9)
    final_ms = float(result.get("assist_final_p50_ms") or 1e9)
    latency_score = max(0.0, 5.0 - (ttft / 300.0) - (final_ms / 1500.0))
    quality_score = float(result.get("answer_quality_score") or 0.0)
    personalization_score = max(0.0, 5.0 * float(result.get("grounding_hit_rate") or 0.0))
    stability_score = max(
        0.0,
        5.0
        - (5.0 * float(result.get("malformed_output_rate") or 0.0))
        - (5.0 * float(result.get("critical_hallucination_rate") or 0.0))
        - (5.0 * float(result.get("persona_contradiction_rate") or 0.0)),
    )
    return round(
        (latency_score * 0.40)
        + (quality_score * 0.35)
        + (personalization_score * 0.15)
        + (stability_score * 0.10),
        4,
    )


def model_family(model_name: str) -> str:
    lowered = model_name.lower()
    if "llama" in lowered:
        return "llama"
    if "qwen" in lowered:
        return "qwen"
    return "other"


def combined_latency(item: dict[str, Any]) -> float:
    ttft = float(item.get("assist_first_token_p50_ms") or 1e9)
    final_ms = float(item.get("assist_final_p50_ms") or 1e9)
    return ttft + final_ms


def choose_recommendation(results: list[dict[str, Any]]) -> dict[str, Any]:
    passing = [item for item in results if item.get("pass_gate")]
    ranked = sorted(
        results,
        key=lambda item: (
            -float(item["weighted_score"]),
            float(item["assist_first_token_p50_ms"] or 1e9),
            float(item["assist_final_p50_ms"] or 1e9),
        ),
    )
    llama = next((item for item in ranked if item.get("pass_gate") and item.get("family") == "llama"), None)
    qwen = next((item for item in ranked if item.get("pass_gate") and item.get("family") == "qwen"), None)

    if llama and qwen:
        quality_gap = float(llama.get("answer_quality_score") or 0.0) - float(qwen.get("answer_quality_score") or 0.0)
        qwen_latency = combined_latency(qwen)
        llama_latency = combined_latency(llama)
        latency_delta = 0.0 if qwen_latency <= 0 else max(0.0, (llama_latency - qwen_latency) / qwen_latency)
        if quality_gap >= 0.3 and latency_delta <= 0.15:
            return {
                "winner": llama,
                "reason": "Llama quality advantage >= 0.3 with latency penalty <= 15%.",
            }
        return {
            "winner": qwen,
            "reason": "Qwen keeps the safer latency profile without a large enough Llama quality gap.",
        }

    if passing:
        return {
            "winner": sorted(passing, key=lambda item: -float(item["weighted_score"]))[0],
            "reason": "Only one passing family remained after hard gates.",
        }

    if ranked:
        return {
            "winner": ranked[0],
            "reason": "No candidate passed the gate; the top weighted result is shown for diagnosis only.",
        }

    return {
        "winner": None,
        "reason": "No benchmark result was produced.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run model sweep for Interview Copilot.")
    parser.add_argument("--manifest", default="artifacts/bench_clips/manifest.json")
    parser.add_argument("--prompt-suite", default="benchmark/prompts/live_answer_set.json")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--warmup-runs", type=int, default=1)
    parser.add_argument("--combo", action="append", default=[])
    parser.add_argument("--stt-device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--provider-kind", default="ollama", choices=["ollama", "openai_compatible"])
    parser.add_argument("--base-url", default="http://127.0.0.1:11434")
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--backend-profile", default="local_baseline")
    parser.add_argument("--run-latency-suite", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--run-quality-suite", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--target-stt-ms", type=float, default=800.0)
    parser.add_argument("--target-first-token-ms", type=float, default=900.0)
    parser.add_argument("--target-assist-final-ms", type=float, default=2500.0)
    parser.add_argument("--out-dir", default="benchmark/reports")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    fallback_manifest_path = Path("benchmark/clips/manifest.json").resolve()
    prompt_suite_path = Path(args.prompt_suite).resolve()

    selected_manifest: Path | None = None
    selected_prompt_suite: Path | None = None
    if args.run_latency_suite:
        if manifest_path.exists():
            selected_manifest = manifest_path
        elif fallback_manifest_path.exists():
            selected_manifest = fallback_manifest_path
        else:
            print(f"[sweep] Latency suite enabled but no manifest found: {manifest_path}", file=sys.stderr)
            return 1
    if args.run_quality_suite:
        if prompt_suite_path.exists():
            selected_prompt_suite = prompt_suite_path
        else:
            print(f"[sweep] Prompt suite not found: {prompt_suite_path}", file=sys.stderr)
            return 1
    if not selected_manifest and not selected_prompt_suite:
        print("[sweep] Both latency and quality suites are disabled.", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    combos = [parse_combo(value) for value in args.combo] if args.combo else combo_default_matrix()
    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []

    for combo in combos:
        try:
            report_path = run_combo(
                combo=combo,
                manifest=selected_manifest,
                prompt_suite=selected_prompt_suite,
                runs=args.runs,
                warmup_runs=args.warmup_runs,
                out_dir=out_dir,
                stt_device=args.stt_device,
                provider_kind=args.provider_kind,
                base_url=args.base_url,
                api_key_env=args.api_key_env,
                backend_label=args.backend_profile,
                target_stt_ms=args.target_stt_ms,
                target_first_token_ms=args.target_first_token_ms,
                target_assist_final_ms=args.target_assist_final_ms,
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
        warm_ttft_p50 = get_metric(report, ["summary", "warm_gate", "assist_first_token_ms", "p50"])
        warm_final_p50 = get_metric(report, ["summary", "warm_gate", "assist_final_ms", "p50"])
        quality = report.get("quality_summary") if isinstance(report.get("quality_summary"), dict) else {}
        pass_latency_gate = bool(
            warm_stt_p50 is not None
            and warm_ttft_p50 is not None
            and warm_final_p50 is not None
            and warm_stt_p50 <= args.target_stt_ms
            and warm_ttft_p50 <= args.target_first_token_ms
            and warm_final_p50 <= args.target_assist_final_ms
        )
        pass_quality_gate = bool(
            float(quality.get("malformed_output_rate") or 0.0) <= 0.02
            and float(quality.get("critical_hallucination_rate") or 0.0) < 0.03
            and float(quality.get("persona_contradiction_rate") or 0.0) < 0.05
        )

        item = {
            "backend_profile": args.backend_profile,
            "provider_kind": args.provider_kind,
            "family": model_family(combo[1]),
            "stt_model": combo[0],
            "assist_model": combo[1],
            "report_path": str(report_path),
            "stt_p50_ms": warm_stt_p50,
            "assist_first_token_p50_ms": warm_ttft_p50,
            "assist_final_p50_ms": warm_final_p50,
            "first_person_compliance": float(quality.get("first_person_compliance") or 0.0),
            "grounding_hit_rate": float(quality.get("grounding_hit_rate") or 0.0),
            "persona_contradiction_rate": float(quality.get("persona_contradiction_rate") or 0.0),
            "critical_hallucination_rate": float(quality.get("critical_hallucination_rate") or 0.0),
            "malformed_output_rate": float(quality.get("malformed_output_rate") or 0.0),
            "answer_quality_score": float(quality.get("answer_quality_score") or 0.0),
            "strategic_usefulness_score": float(quality.get("strategic_usefulness_score") or 0.0),
            "naturalness_score": float(quality.get("naturalness_score") or 0.0),
            "pass_latency_gate": pass_latency_gate,
            "pass_quality_gate": pass_quality_gate,
            "benchmark_pass": bool(report.get("benchmark_pass")),
            "benchmark_blocked_reasons": report.get("benchmark_blocked_reasons") or [],
            "pass_gate": pass_latency_gate and pass_quality_gate,
        }
        item["weighted_score"] = weighted_score(item)
        results.append(item)

    passing = [item for item in results if item["pass_gate"]]
    ranked = sorted(
        results,
        key=lambda item: (
            -float(item["weighted_score"]),
            float(item["assist_first_token_p50_ms"] or 1e9),
            float(item["assist_final_p50_ms"] or 1e9),
        ),
    )
    recommendation = choose_recommendation(results)
    final = {
        "generated_at": dt.datetime.utcnow().isoformat() + "Z",
        "backend_profile": args.backend_profile,
        "provider_kind": args.provider_kind,
        "manifest": str(selected_manifest) if selected_manifest else None,
        "prompt_suite": str(selected_prompt_suite) if selected_prompt_suite else None,
        "warmup_runs": args.warmup_runs,
        "targets": {
            "stt_p50_ms": args.target_stt_ms,
            "assist_first_token_p50_ms": args.target_first_token_ms,
            "assist_final_p50_ms": args.target_assist_final_ms,
        },
        "results": results,
        "failures": failures,
        "fastest_candidate": min(
            results,
            default=None,
            key=lambda item: (
                float(item["assist_first_token_p50_ms"] or 1e9),
                float(item["assist_final_p50_ms"] or 1e9),
            ),
        ),
        "best_candidate": ranked[0] if ranked else None,
        "passing_candidates": passing,
        "recommendation": recommendation["reason"],
        "recommended_candidate": recommendation["winner"],
    }
    out_path = out_dir / f"sweep_{dt.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    out_path.write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[sweep] results: {out_path}")
    print(json.dumps(final, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
