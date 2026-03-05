#!/usr/bin/env python3
"""Judge SFT candidates with hybrid rule-based and optional external scoring."""

from __future__ import annotations

import argparse
import json
import os
import statistics
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from training_common import (
    contains_first_person,
    critical_failure_tags,
    normalize_text,
    parse_json,
    parse_jsonl,
    safe_float,
    write_json,
    write_jsonl,
)


def assistant_text(row: dict[str, Any]) -> str:
    for message in row.get("messages") or []:
        if isinstance(message, dict) and message.get("role") == "assistant":
            return normalize_text(str(message.get("content") or ""))
    return ""


def user_text(row: dict[str, Any]) -> str:
    for message in row.get("messages") or []:
        if isinstance(message, dict) and message.get("role") == "user":
            return normalize_text(str(message.get("content") or ""))
    return ""


def rule_judge(row: dict[str, Any]) -> dict[str, Any]:
    answer = assistant_text(row)
    metadata = row.get("metadata") or {}
    failures = critical_failure_tags(answer)
    quality = safe_float(metadata.get("quality_score"), 0.0)
    groundedness = min(5, max(1, int(round(quality * 5))))
    if metadata.get("candidate_specific") and quality < 0.6:
        groundedness = min(groundedness, 3)
    speakability = 5 if not failures else max(1, 5 - len(failures))
    correctness = 5 if quality >= 0.8 else 4 if quality >= 0.65 else 3 if quality >= 0.5 else 2
    copilot_tone = 5 if contains_first_person(answer) and "?" not in answer[-1:] else 3
    concision = 5 if 45 <= len(answer.split()) <= 140 else 3
    scores = {
        "correctness": correctness,
        "groundedness": groundedness,
        "speakability": speakability,
        "copilot_tone": copilot_tone,
        "concision": concision,
    }
    average = statistics.mean(scores.values())
    passed = average >= 4.2 and min(scores["correctness"], scores["groundedness"], scores["speakability"]) >= 4 and not failures
    return {
        "provider": "rules",
        "pass": passed,
        "scores": scores,
        "critical_failures": failures,
        "average_score": round(average, 4),
        "notes": "",
    }


def external_judge(row: dict[str, Any], config: dict[str, Any]) -> dict[str, Any] | None:
    provider_kind = str(config.get("provider_kind") or "").strip().lower()
    if provider_kind != "openai_compatible":
        return None
    base_url = str(config.get("base_url") or "").rstrip("/")
    model = str(config.get("model") or "").strip()
    if not base_url or not model:
        return None
    api_key = os.environ.get(str(config.get("api_key_env") or "OPENAI_API_KEY"), "")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    prompt = (
        "Score the candidate answer for correctness, groundedness, speakability, copilot_tone, and concision. "
        "Return strict JSON with fields: pass, scores, critical_failures, notes. "
        "Use integer scores from 1 to 5. Pass only if the answer is speakable, first-person, and grounded."
    )
    body = {
        "model": model,
        "temperature": safe_float(config.get("temperature"), 0.0),
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": json.dumps(row, ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
    }
    endpoint = base_url + "/chat/completions"
    request = Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urlopen(request, timeout=max(5, int(config.get("timeout_sec") or 45))) as response:
        payload = json.loads(response.read().decode("utf-8", errors="ignore"))
    content = (
        payload.get("choices", [{}])[0].get("message", {}).get("content", "")
        if isinstance(payload, dict)
        else ""
    )
    if not isinstance(content, str) or not content.strip():
        return None
    parsed = json.loads(content)
    if not isinstance(parsed, dict):
        return None
    parsed["provider"] = "external"
    return parsed


def main() -> None:
    parser = argparse.ArgumentParser(description="Judge SFT candidates with hybrid scoring.")
    parser.add_argument("--input-jsonl", default="artifacts/curation/session_candidates.jsonl")
    parser.add_argument("--judge-config", default="configs/judge_config.json")
    parser.add_argument("--output-accepted", default="artifacts/curation/session_candidates.accepted.jsonl")
    parser.add_argument("--output-rejected", default="artifacts/curation/session_candidates.rejected.jsonl")
    parser.add_argument("--output-reports", default="artifacts/curation/session_judge_reports.jsonl")
    parser.add_argument("--summary-report", default="artifacts/curation/session_judge_summary.json")
    args = parser.parse_args()

    input_path = Path(args.input_jsonl).resolve()
    config_path = Path(args.judge_config).resolve()
    accepted_path = Path(args.output_accepted).resolve()
    rejected_path = Path(args.output_rejected).resolve()
    reports_path = Path(args.output_reports).resolve()
    summary_path = Path(args.summary_report).resolve()

    rows = parse_jsonl(input_path)
    config = parse_json(config_path) if config_path.exists() else {}
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    warnings: list[str] = []

    for index, row in enumerate(rows):
        rule_report = rule_judge(row)
        final_report = dict(rule_report)
        try:
            ext_report = external_judge(row, config)
            if ext_report:
                scores = ext_report.get("scores") or {}
                avg = statistics.mean([safe_float(value, 0.0) for value in scores.values()]) if scores else 0.0
                final_report = {
                    "provider": "hybrid",
                    "pass": bool(ext_report.get("pass")),
                    "scores": scores,
                    "critical_failures": ext_report.get("critical_failures") or rule_report["critical_failures"],
                    "average_score": round(avg, 4),
                    "notes": str(ext_report.get("notes") or ""),
                    "rule_pass": rule_report["pass"],
                    "rule_scores": rule_report["scores"],
                }
        except Exception as exc:
            warnings.append(f"external_judge_failed:{type(exc).__name__}:{exc}")

        metadata = dict(row.get("metadata") or {})
        metadata["judge_status"] = "accepted" if final_report["pass"] else "rejected"
        judged_row = dict(row)
        judged_row["metadata"] = metadata

        report_row = {
            "schema_version": "judge_report.v1",
            "index": index,
            "question": user_text(row),
            "answer": assistant_text(row),
            "metadata": metadata,
            "report": final_report,
        }
        reports.append(report_row)
        if final_report["pass"]:
            accepted.append(judged_row)
        else:
            rejected.append(judged_row)

    write_jsonl(accepted_path, accepted)
    write_jsonl(rejected_path, rejected)
    write_jsonl(reports_path, reports)
    write_json(
        summary_path,
        {
            "ok": True,
            "input": str(input_path),
            "accepted": len(accepted),
            "rejected": len(rejected),
            "warnings": warnings,
            "judge_config": str(config_path),
        },
    )
    print(
        json.dumps(
            {
                "ok": True,
                "accepted": len(accepted),
                "rejected": len(rejected),
                "summary_report": str(summary_path),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
