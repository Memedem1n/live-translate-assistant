#!/usr/bin/env python3
"""
Repeatable local benchmark runner for Interview Copilot.

Supports:
- audio latency suite (STT + streaming answer)
- text quality suite (fixed prompt set)
- Ollama and OpenAI-compatible providers
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
from typing import Any

from runtime_env import (
    detect_cuda_runtime,
    is_cuda_runtime_error,
    load_whisper_model,
    prepare_runtime_environment,
)
from training_common import (
    contains_first_person,
    critical_failure_tags,
    lexical_overlap_ratio,
    normalize_text,
    quality_score,
    sentence_count,
    word_count,
)

PRIMARY_PROMPT = (
    "You are a live technical interview copilot. Output strict JSON only: "
    '{"answer_en":"...","confidence":0.0,"risk_flags":["..."]}. '
    "answer_en must sound like a real candidate speaking in first person."
)


def percentile(values: list[float], ratio: float) -> float | None:
    if not values:
        return None
    sorted_vals = sorted(values)
    idx = max(0, min(len(sorted_vals) - 1, int((len(sorted_vals) * ratio) - 1)))
    return round(sorted_vals[idx], 2)


def summary(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "latest": None, "p50": None, "p95": None, "mean": None}
    return {
        "count": len(values),
        "latest": round(values[-1], 2),
        "p50": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "mean": round(statistics.fmean(values), 2),
    }


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object JSON: {path}")
    return payload


def load_clip_manifest(path: Path) -> dict[str, Any]:
    data = load_json(path)
    if not isinstance(data.get("clips"), list):
        raise ValueError("Clip manifest must contain 'clips' array.")
    return data


def load_prompt_suite(path: Path) -> dict[str, Any]:
    data = load_json(path)
    if not isinstance(data.get("prompts"), list):
        raise ValueError("Prompt suite must contain 'prompts' array.")
    return data


def transcribe_clip(model: Any, clip_path: Path) -> dict[str, Any]:
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


def build_user_prompt(context_lines: list[str], remote_question: str) -> str:
    lines = [normalize_text(item) for item in context_lines if normalize_text(item)]
    context = "\n".join(lines)
    if context:
        return f"Context:\n{context}\n\nLatest remote sentence:\n{normalize_text(remote_question)}"
    return f"Latest remote sentence:\n{normalize_text(remote_question)}"


def make_headers(api_key: str = "") -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def stream_ollama(
    *,
    base_url: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
) -> dict[str, Any]:
    payload = {
        "model": model,
        "stream": True,
        "options": {"temperature": 0.2, "num_ctx": 4096},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    request = urllib.request.Request(
        url=f"{base_url.rstrip('/')}/api/chat",
        method="POST",
        headers=make_headers(),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    )
    started = time.perf_counter()
    first_token_ms: float | None = None
    raw = ""
    with urllib.request.urlopen(request, timeout=120) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8").strip()
            if not line:
                continue
            try:
                token_payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            token = str((token_payload.get("message") or {}).get("content") or "")
            if token:
                raw += token
                if first_token_ms is None:
                    first_token_ms = (time.perf_counter() - started) * 1000.0
    final_ms = (time.perf_counter() - started) * 1000.0
    return {
        "raw": raw,
        "first_token_ms": round(first_token_ms, 2) if first_token_ms is not None else None,
        "final_ms": round(final_ms, 2),
    }


def stream_openai_compatible(
    *,
    base_url: str,
    model: str,
    api_key: str,
    system_prompt: str,
    user_prompt: str,
) -> dict[str, Any]:
    payload = {
        "model": model,
        "stream": True,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    request = urllib.request.Request(
        url=f"{base_url.rstrip('/')}/chat/completions",
        method="POST",
        headers=make_headers(api_key),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    )
    started = time.perf_counter()
    first_token_ms: float | None = None
    raw = ""
    with urllib.request.urlopen(request, timeout=120) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="ignore").strip()
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                token_payload = json.loads(data)
            except json.JSONDecodeError:
                continue
            choices = token_payload.get("choices") or [{}]
            delta = choices[0].get("delta") or {}
            message = choices[0].get("message") or {}
            token = str(delta.get("content") or message.get("content") or "")
            if token:
                raw += token
                if first_token_ms is None:
                    first_token_ms = (time.perf_counter() - started) * 1000.0
    final_ms = (time.perf_counter() - started) * 1000.0
    return {
        "raw": raw,
        "first_token_ms": round(first_token_ms, 2) if first_token_ms is not None else None,
        "final_ms": round(final_ms, 2),
    }


def stream_assist(
    *,
    provider_kind: str,
    base_url: str,
    model: str,
    api_key: str,
    context_lines: list[str],
    remote_question: str,
    system_prompt: str,
) -> dict[str, Any]:
    user_prompt = build_user_prompt(context_lines, remote_question)
    if provider_kind == "openai_compatible":
        return stream_openai_compatible(
            base_url=base_url,
            model=model,
            api_key=api_key,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
        )
    return stream_ollama(
        base_url=base_url,
        model=model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
    )


def prewarm_assist(
    *,
    provider_kind: str,
    base_url: str,
    model: str,
    api_key: str,
) -> float:
    started = time.perf_counter()
    _ = stream_assist(
        provider_kind=provider_kind,
        base_url=base_url,
        model=model,
        api_key=api_key,
        context_lines=["[remote] warmup"],
        remote_question='Respond with {"answer_en":"ok","confidence":0.9,"risk_flags":[]}',
        system_prompt=PRIMARY_PROMPT,
    )
    return round((time.perf_counter() - started) * 1000.0, 2)


def append_metric(target: list[float], value: float | None) -> None:
    if value is None:
        return
    target.append(float(value))


def extract_json_candidate(raw: str) -> dict[str, Any] | None:
    cleaned = raw.strip()
    if not cleaned:
        return None
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(cleaned[start : end + 1])
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def evaluate_prompt_response(prompt_item: dict[str, Any], answer: str, malformed: bool) -> dict[str, Any]:
    context_lines = [str(item) for item in (prompt_item.get("context_lines") or []) if str(item).strip()]
    expected_keywords = [str(item).lower() for item in (prompt_item.get("expected_keywords") or []) if str(item).strip()]
    strategic_keywords = [str(item).lower() for item in (prompt_item.get("strategic_keywords") or []) if str(item).strip()]
    contradiction_keywords = [
        str(item).lower() for item in (prompt_item.get("contradiction_keywords") or []) if str(item).strip()
    ]
    answer_lower = normalize_text(answer).lower()
    expected_hits = [keyword for keyword in expected_keywords if keyword in answer_lower]
    strategic_hits = [keyword for keyword in strategic_keywords if keyword in answer_lower]
    contradictions = [keyword for keyword in contradiction_keywords if keyword in answer_lower]
    first_person = contains_first_person(answer)
    failures = critical_failure_tags(answer)
    context_blob = "\n".join(context_lines)
    overlap = lexical_overlap_ratio(context_blob, answer) if context_blob else 0.0
    grounding_hit = bool(expected_hits) or overlap >= 0.08 or not context_lines
    contradiction = bool(contradictions)
    critical_hallucination = contradiction or malformed or "contains_code" in failures or "ai_disclaimer" in failures

    heuristic_quality = quality_score(
        answer,
        question=str(prompt_item.get("question") or ""),
        context_lines=context_lines,
        candidate_specific=bool(prompt_item.get("candidate_specific")),
    )
    answer_quality_score = min(5.0, max(1.0, round((heuristic_quality * 5.0) + (0.4 if expected_hits else 0.0), 2)))
    strategic_score = min(
        5.0,
        max(1.0, round(2.0 + (2.0 * len(strategic_hits) / max(1, len(strategic_keywords))) + (0.5 if "because" in answer_lower else 0.0), 2)),
    )
    naturalness_score = min(
        5.0,
        max(
            1.0,
            round(
                2.0
                + (1.0 if first_person else 0.0)
                + (1.0 if 35 <= word_count(answer) <= 140 else 0.0)
                + (1.0 if sentence_count(answer) >= 2 else 0.0)
                - (0.5 if failures else 0.0),
                2,
            ),
        ),
    )

    return {
        "first_person": first_person,
        "grounding_hit": grounding_hit,
        "keyword_hit_rate": round(len(expected_hits) / max(1, len(expected_keywords)), 4),
        "expected_hits": expected_hits,
        "strategic_hits": strategic_hits,
        "persona_contradiction": contradiction,
        "contradictions": contradictions,
        "critical_hallucination": critical_hallucination,
        "malformed_output": malformed,
        "critical_failures": failures,
        "answer_quality_score": answer_quality_score,
        "strategic_usefulness_score": strategic_score,
        "naturalness_score": naturalness_score,
    }


def quality_summary(prompt_results: list[dict[str, Any]]) -> dict[str, Any]:
    if not prompt_results:
        return {
            "count": 0,
            "first_person_compliance": 0.0,
            "grounding_hit_rate": 0.0,
            "persona_contradiction_rate": 0.0,
            "critical_hallucination_rate": 0.0,
            "malformed_output_rate": 0.0,
            "answer_quality_score": 0.0,
            "strategic_usefulness_score": 0.0,
            "naturalness_score": 0.0,
        }
    count = len(prompt_results)
    return {
        "count": count,
        "first_person_compliance": round(sum(1 for item in prompt_results if item["first_person"]) / count, 4),
        "grounding_hit_rate": round(sum(1 for item in prompt_results if item["grounding_hit"]) / count, 4),
        "persona_contradiction_rate": round(
            sum(1 for item in prompt_results if item["persona_contradiction"]) / count, 4
        ),
        "critical_hallucination_rate": round(
            sum(1 for item in prompt_results if item["critical_hallucination"]) / count, 4
        ),
        "malformed_output_rate": round(sum(1 for item in prompt_results if item["malformed_output"]) / count, 4),
        "answer_quality_score": round(
            statistics.fmean(float(item["answer_quality_score"]) for item in prompt_results), 4
        ),
        "strategic_usefulness_score": round(
            statistics.fmean(float(item["strategic_usefulness_score"]) for item in prompt_results), 4
        ),
        "naturalness_score": round(
            statistics.fmean(float(item["naturalness_score"]) for item in prompt_results), 4
        ),
    }


def benchmark_pass(
    *,
    stt_p50: float | None,
    first_token_p50: float | None,
    final_p50: float | None,
    quality_metrics: dict[str, Any],
    target_stt_ms: float,
    target_first_token_ms: float,
    target_final_ms: float,
) -> tuple[bool, list[str]]:
    blocked: list[str] = []
    if stt_p50 is not None and stt_p50 > target_stt_ms:
        blocked.append("stt_latency")
    if first_token_p50 is not None and first_token_p50 > target_first_token_ms:
        blocked.append("ttft_latency")
    if final_p50 is not None and final_p50 > target_final_ms:
        blocked.append("final_latency")
    if quality_metrics.get("malformed_output_rate", 0.0) > 0.02:
        blocked.append("malformed_output")
    if quality_metrics.get("critical_hallucination_rate", 0.0) >= 0.03:
        blocked.append("critical_hallucination")
    if quality_metrics.get("persona_contradiction_rate", 0.0) >= 0.05:
        blocked.append("persona_contradiction")
    return len(blocked) == 0, blocked


def main() -> int:
    parser = argparse.ArgumentParser(description="Run repeatable STT + assist benchmarks.")
    parser.add_argument("--clips-manifest", default="artifacts/bench_clips/manifest.json")
    parser.add_argument("--prompt-suite", default="benchmark/prompts/live_answer_set.json")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--warmup-runs", type=int, default=1)
    parser.add_argument("--stt-model", default="large-v3-turbo")
    parser.add_argument("--stt-device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--stt-compute-type", default="auto")
    parser.add_argument("--assist-model", default="llama3.1:8b-instruct-q4_K_M")
    parser.add_argument("--provider-kind", default="ollama", choices=["ollama", "openai_compatible"])
    parser.add_argument("--base-url", default="http://127.0.0.1:11434")
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--backend-label", default="local_baseline")
    parser.add_argument("--answer-format", default="speakable_first_person")
    parser.add_argument("--target-stt-ms", type=float, default=800.0)
    parser.add_argument("--target-first-token-ms", type=float, default=900.0)
    parser.add_argument("--target-final-ms", type=float, default=2500.0)
    parser.add_argument("--out", default="benchmark/reports")
    args = parser.parse_args()

    prepare_runtime_environment()
    runtime_info = detect_cuda_runtime()
    clips_manifest_path = Path(args.clips_manifest).resolve()
    prompt_suite_path = Path(args.prompt_suite).resolve()

    manifest: dict[str, Any] | None = None
    prompt_suite: dict[str, Any] | None = None
    if clips_manifest_path.exists():
        manifest = load_clip_manifest(clips_manifest_path)
    if prompt_suite_path.exists():
        prompt_suite = load_prompt_suite(prompt_suite_path)
    if not manifest and not prompt_suite:
        print("[benchmark] No clip manifest or prompt suite available.", file=sys.stderr)
        return 1

    clips = manifest.get("clips", []) if manifest else []
    prompts = prompt_suite.get("prompts", []) if prompt_suite else []

    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:
        if clips:
            print("[benchmark] faster-whisper not available. Install with: pip install faster-whisper", file=sys.stderr)
            print(f"[benchmark] Detail: {exc}", file=sys.stderr)
            return 1

    model = None
    resolved_device = None
    resolved_compute = None
    fallback_to_cpu_count = 0
    if clips:
        print(
            f"[benchmark] Loading STT model: {args.stt_model} (device={args.stt_device}, compute={args.stt_compute_type})"
        )
        try:
            model, resolved_device, resolved_compute, runtime_info, _errors = load_whisper_model(
                model_name=args.stt_model,
                runtime_mode=args.stt_device,
                compute_type=args.stt_compute_type,
            )
        except Exception as exc:
            print(f"[benchmark] Failed to load Whisper model: {exc}", file=sys.stderr)
            return 1

    api_key = os.environ.get(args.api_key_env, "")
    try:
        assist_prewarm_ms = prewarm_assist(
            provider_kind=args.provider_kind,
            base_url=args.base_url,
            model=args.assist_model,
            api_key=api_key,
        )
        print(f"[benchmark] Assist prewarm complete in {assist_prewarm_ms}ms")
    except Exception as exc:
        print(f"[benchmark] Assist prewarm failed: {exc}", file=sys.stderr)
        return 1

    warmup_runs = max(0, min(args.warmup_runs, args.runs))
    stt_all: list[float] = []
    stt_cold: list[float] = []
    stt_warm: list[float] = []
    assist_first_all: list[float] = []
    assist_first_cold: list[float] = []
    assist_first_warm: list[float] = []
    assist_final_all: list[float] = []
    assist_final_cold: list[float] = []
    assist_final_warm: list[float] = []
    clip_results: list[dict[str, Any]] = []
    active_device = resolved_device
    active_compute = resolved_compute

    for run_idx in range(args.runs):
        bucket = "cold_start" if run_idx < warmup_runs else "warm_gate"
        print(f"[benchmark] Run {run_idx + 1}/{args.runs} [{bucket}]")
        for clip in clips:
            clip_id = str(clip.get("id") or f"clip_{run_idx}")
            clip_path = (clips_manifest_path.parent / str(clip.get("audio_path") or "")).resolve()
            if not clip_path.exists():
                clip_results.append({"run": run_idx + 1, "bucket": bucket, "clip_id": clip_id, "missing_clip": True})
                continue
            try:
                stt_result = transcribe_clip(model, clip_path)
            except Exception as exc:
                should_fallback_cpu = (
                    active_device == "cuda"
                    and args.stt_device in ("auto", "cuda")
                    and is_cuda_runtime_error(exc)
                )
                if should_fallback_cpu:
                    fallback_to_cpu_count += 1
                    model, active_device, active_compute, runtime_info, _errors = load_whisper_model(
                        model_name=args.stt_model,
                        runtime_mode="cpu",
                        compute_type="auto",
                    )
                    stt_result = transcribe_clip(model, clip_path)
                else:
                    print(f"[benchmark] STT transcription failed for clip {clip_id}: {exc}", file=sys.stderr)
                    return 1

            append_metric(stt_all, stt_result["latency_ms"])
            append_metric(stt_cold if bucket == "cold_start" else stt_warm, stt_result["latency_ms"])
            context_lines = [str(item) for item in (clip.get("context_lines") or []) if str(item).strip()]
            remote_question = stt_result["text_en"] or str(clip.get("reference_text") or "")
            if not remote_question:
                clip_results.append(
                    {
                        "run": run_idx + 1,
                        "bucket": bucket,
                        "clip_id": clip_id,
                        "clip_path": str(clip_path),
                        "stt_latency_ms": stt_result["latency_ms"],
                        "assist_skipped": True,
                        "reason": "no_transcript",
                    }
                )
                continue
            assist_result = stream_assist(
                provider_kind=args.provider_kind,
                base_url=args.base_url,
                model=args.assist_model,
                api_key=api_key,
                context_lines=context_lines,
                remote_question=remote_question,
                system_prompt=PRIMARY_PROMPT,
            )
            append_metric(assist_first_all, assist_result["first_token_ms"])
            append_metric(assist_final_all, assist_result["final_ms"])
            append_metric(assist_first_cold if bucket == "cold_start" else assist_first_warm, assist_result["first_token_ms"])
            append_metric(assist_final_cold if bucket == "cold_start" else assist_final_warm, assist_result["final_ms"])
            clip_results.append(
                {
                    "run": run_idx + 1,
                    "bucket": bucket,
                    "clip_id": clip_id,
                    "clip_path": str(clip_path),
                    "stt_latency_ms": stt_result["latency_ms"],
                    "assist_first_token_ms": assist_result["first_token_ms"],
                    "assist_final_ms": assist_result["final_ms"],
                }
            )

    prompt_results: list[dict[str, Any]] = []
    for prompt_item in prompts:
        question = str(prompt_item.get("question") or "").strip()
        if not question:
            continue
        assist_result = stream_assist(
            provider_kind=args.provider_kind,
            base_url=args.base_url,
            model=args.assist_model,
            api_key=api_key,
            context_lines=[str(item) for item in (prompt_item.get("context_lines") or []) if str(item).strip()],
            remote_question=question,
            system_prompt=PRIMARY_PROMPT,
        )
        payload = extract_json_candidate(str(assist_result["raw"] or ""))
        answer = normalize_text(str((payload or {}).get("answer_en") or ""))
        malformed = payload is None or not answer
        if malformed:
            answer = normalize_text(str(assist_result["raw"] or ""))
        evaluation = evaluate_prompt_response(prompt_item, answer, malformed)
        prompt_results.append(
            {
                "id": str(prompt_item.get("id") or ""),
                "category": str(prompt_item.get("category") or "unknown"),
                "candidate_specific": bool(prompt_item.get("candidate_specific")),
                "question": question,
                "answer": answer,
                "first_token_ms": assist_result["first_token_ms"],
                "final_ms": assist_result["final_ms"],
                **evaluation,
            }
        )

    quality_metrics = quality_summary(prompt_results)
    warm_stt_p50 = summary(stt_warm)["p50"] if stt_warm else None
    warm_first_token_p50 = summary(assist_first_warm)["p50"] if assist_first_warm else None
    warm_final_p50 = summary(assist_final_warm)["p50"] if assist_final_warm else None
    passed, blocked_reasons = benchmark_pass(
        stt_p50=warm_stt_p50,
        first_token_p50=warm_first_token_p50,
        final_p50=warm_final_p50,
        quality_metrics=quality_metrics,
        target_stt_ms=args.target_stt_ms,
        target_first_token_ms=args.target_first_token_ms,
        target_final_ms=args.target_final_ms,
    )

    report = {
        "generated_at": dt.datetime.utcnow().isoformat() + "Z",
        "backend_label": args.backend_label,
        "provider_kind": args.provider_kind,
        "clips_manifest": str(clips_manifest_path) if manifest else None,
        "prompt_suite": str(prompt_suite_path) if prompt_suite else None,
        "runs": args.runs,
        "warmup_runs": warmup_runs,
        "stt_model": args.stt_model,
        "assist_model": args.assist_model,
        "base_url": args.base_url,
        "answer_format": args.answer_format,
        "targets": {
            "stt_p50_ms": args.target_stt_ms,
            "assist_first_token_p50_ms": args.target_first_token_ms,
            "assist_final_p50_ms": args.target_final_ms,
        },
        "resolved_runtime": {
            "requested_mode": args.stt_device,
            "device": active_device,
            "compute_type": active_compute,
        },
        "runtime_trace": {
            "prepared_paths": runtime_info.get("prepared_paths", []),
            "cublas_path": runtime_info.get("cublas_path"),
            "cudnn_path": runtime_info.get("cudnn_path"),
            "cuda_available": runtime_info.get("cuda_available", False),
            "cuda_device_count": runtime_info.get("cuda_device_count", 0),
            "fallback_to_cpu_count": fallback_to_cpu_count,
            "assist_prewarm_ms": assist_prewarm_ms,
        },
        "summary": {
            "stt_first_chunk_ms": summary(stt_all),
            "assist_first_token_ms": summary(assist_first_all),
            "assist_final_ms": summary(assist_final_all),
            "cold_start": {
                "stt_first_chunk_ms": summary(stt_cold),
                "assist_first_token_ms": summary(assist_first_cold),
                "assist_final_ms": summary(assist_final_cold),
            },
            "warm_gate": {
                "stt_first_chunk_ms": summary(stt_warm),
                "assist_first_token_ms": summary(assist_first_warm),
                "assist_final_ms": summary(assist_final_warm),
            },
        },
        "quality_summary": quality_metrics,
        "benchmark_pass": passed,
        "benchmark_blocked_reasons": blocked_reasons,
        "clips": clip_results,
        "prompt_results": prompt_results,
    }

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"benchmark_{dt.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    with out_file.open("w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)

    print("[benchmark] Complete")
    print(f"[benchmark] Report: {out_file}")
    print(json.dumps({"summary": report["summary"], "quality_summary": quality_metrics}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
