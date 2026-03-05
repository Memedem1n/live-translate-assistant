#!/usr/bin/env python3
"""Build `dpo.v1` chosen/rejected pairs from judged rows and reviewed session exports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from training_common import critical_failure_tags, normalize_key, parse_jsonl, write_json, write_jsonl

SYSTEM_PROMPT = (
    "You are a live technical interview copilot. Produce a concise, speakable, first-person English answer. "
    "Do not ask the interviewer a question back. Do not write code blocks."
)


def canonical_prompt_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    output: list[dict[str, str]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip()
        content = str(message.get("content") or "").strip()
        if role in {"system", "user"} and content:
            output.append({"role": role, "content": content})
    return output


def prompt_messages_from_row(row: dict[str, Any]) -> list[dict[str, str]]:
    return canonical_prompt_messages(list(row.get("messages") or []))


def answer_text(row: dict[str, Any]) -> str:
    for message in row.get("messages") or []:
        if isinstance(message, dict) and message.get("role") == "assistant":
            return str(message.get("content") or "").strip()
    return ""


def prompt_key_from_messages(messages: list[dict[str, str]]) -> str:
    return normalize_key("\n".join(item["content"] for item in messages))


def prompt_key(row: dict[str, Any]) -> str:
    return prompt_key_from_messages(prompt_messages_from_row(row))


def load_sampled_completions(path: Path) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for row in parse_jsonl(path):
        key = str(row.get("prompt_key") or "").strip()
        if not key:
            key = prompt_key_from_messages(canonical_prompt_messages(list(row.get("messages") or [])))
        completion = str(row.get("completion") or "").strip()
        if not key or not completion:
            continue
        buckets.setdefault(key, []).append(row)
    return buckets


def build_user_prompt(question: str, context_lines: list[str]) -> str:
    sections: list[str] = []
    if context_lines:
        sections.append("Relevant context lines:\n" + "\n".join(f"- {line}" for line in context_lines))
    sections.append(f"Latest interviewer question:\n{question}")
    return "\n\n".join(sections).strip()


def build_session_prompt_messages(session: dict[str, Any], assist: dict[str, Any]) -> list[dict[str, str]]:
    transcripts = session.get("transcripts") or []
    transcript_map = {
        str(item.get("id") or "").strip(): str(item.get("text") or "").strip()
        for item in transcripts
        if isinstance(item, dict)
    }
    question = str(assist.get("sourceText") or "").strip()
    if not question:
        question = transcript_map.get(str(assist.get("transcriptId") or "").strip(), "")
    if not question:
        question = "Please answer the interviewer clearly and directly."
    context_lines = [str(item).strip() for item in (assist.get("contextLinesUsed") or []) if str(item).strip()]
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_prompt(question, context_lines)},
    ]


def load_reviewed_sessions(session_dir: Path) -> list[dict[str, Any]]:
    if not session_dir.exists():
        return []
    output: list[dict[str, Any]] = []
    for path in sorted(session_dir.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(payload, dict) and payload.get("id") and isinstance(payload.get("assists"), list):
            output.append(payload)
    return output


def index_reviewed_assists(session_dir: Path) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for session in load_reviewed_sessions(session_dir):
        session_id = str(session.get("id") or "").strip()
        for assist in session.get("assists") or []:
            if not isinstance(assist, dict):
                continue
            review_label = str(assist.get("reviewLabel") or "").strip()
            answer = str(assist.get("answerEn") or assist.get("rawText") or "").strip()
            if review_label not in {"chosen", "rejected"} or not answer:
                continue
            messages = build_session_prompt_messages(session, assist)
            key = prompt_key_from_messages(messages)
            buckets.setdefault(key, []).append(
                {
                    "session_id": session_id,
                    "assist_id": str(assist.get("id") or "").strip(),
                    "review_label": review_label,
                    "review_tags": [str(tag).strip() for tag in (assist.get("reviewTags") or []) if str(tag).strip()],
                    "messages": messages,
                    "answer": answer,
                    "source": "session_review",
                }
            )
    return buckets


def pair_from_legacy_rows(chosen_rows: list[dict[str, Any]], rejected_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rejected_map: dict[str, list[dict[str, Any]]] = {}
    for row in rejected_rows:
        rejected_map.setdefault(prompt_key(row), []).append(row)

    pairs: list[dict[str, Any]] = []
    for row in chosen_rows:
        key = prompt_key(row)
        rejected_bucket = rejected_map.get(key) or []
        if not rejected_bucket:
            continue
        rejected_row = rejected_bucket[0]
        chosen_answer = answer_text(row)
        rejected_answer = answer_text(rejected_row)
        if not chosen_answer or not rejected_answer or chosen_answer == rejected_answer:
            continue
        chosen_meta = row.get("metadata") or {}
        rejected_meta = rejected_row.get("metadata") or {}
        pairs.append(
            {
                "schema_version": "dpo.v1",
                "prompt_messages": prompt_messages_from_row(row),
                "chosen": chosen_answer,
                "rejected": rejected_answer,
                "metadata": {
                    "source": str(chosen_meta.get("source_bucket") or chosen_meta.get("source") or "session"),
                    "base_model": "",
                    "judge_provider": "hybrid",
                    "reason_tags": rejected_meta.get("critical_failure_tags") or critical_failure_tags(rejected_answer),
                    "session_id": str(chosen_meta.get("session_id") or rejected_meta.get("session_id") or ""),
                    "pair_confidence": 0.8,
                },
            }
        )
    return pairs


def build_session_pairs(
    reviewed_map: dict[str, list[dict[str, Any]]],
    sampled_map: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    pairs: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for key, reviewed_rows in reviewed_map.items():
        chosen_rows = [row for row in reviewed_rows if row["review_label"] == "chosen"]
        rejected_rows = [row for row in reviewed_rows if row["review_label"] == "rejected"]
        sampled_rows = sampled_map.get(key) or []

        for chosen in chosen_rows:
            candidate_rejected = next(
                (
                    row
                    for row in rejected_rows
                    if normalize_key(row["answer"]) != normalize_key(chosen["answer"])
                ),
                None,
            )
            source = "reviewed_session_pair"
            confidence = 0.95
            reason_tags = candidate_rejected["review_tags"] if candidate_rejected else []
            rejected_answer = candidate_rejected["answer"] if candidate_rejected else ""
            if not rejected_answer:
                sample = next(
                    (
                        row
                        for row in sampled_rows
                        if normalize_key(str(row.get("completion") or "")) != normalize_key(chosen["answer"])
                    ),
                    None,
                )
                if sample:
                    rejected_answer = str(sample.get("completion") or "").strip()
                    reason_tags = critical_failure_tags(rejected_answer)
                    source = "reviewed_plus_sampled"
                    confidence = 0.88
            if not rejected_answer:
                continue
            pair_key = (key, normalize_key(chosen["answer"]), normalize_key(rejected_answer))
            if pair_key in seen:
                continue
            seen.add(pair_key)
            pairs.append(
                {
                    "schema_version": "dpo.v1",
                    "prompt_messages": chosen["messages"],
                    "chosen": chosen["answer"],
                    "rejected": rejected_answer,
                    "metadata": {
                        "source": source,
                        "base_model": "",
                        "judge_provider": "hybrid",
                        "reason_tags": reason_tags or critical_failure_tags(rejected_answer),
                        "session_id": chosen["session_id"],
                        "pair_confidence": confidence,
                    },
                }
            )

        for rejected in rejected_rows:
            chosen_answer = ""
            source = "reviewed_session_pair"
            confidence = 0.95
            reason_tags = rejected["review_tags"] or critical_failure_tags(rejected["answer"])
            candidate_chosen = next(
                (
                    row
                    for row in chosen_rows
                    if normalize_key(row["answer"]) != normalize_key(rejected["answer"])
                ),
                None,
            )
            if candidate_chosen:
                chosen_answer = candidate_chosen["answer"]
            else:
                sample = next(
                    (
                        row
                        for row in sampled_rows
                        if normalize_key(str(row.get("completion") or "")) != normalize_key(rejected["answer"])
                    ),
                    None,
                )
                if sample:
                    chosen_answer = str(sample.get("completion") or "").strip()
                    source = "sampled_repair_pair"
                    confidence = 0.84
            if not chosen_answer:
                continue
            pair_key = (key, normalize_key(chosen_answer), normalize_key(rejected["answer"]))
            if pair_key in seen:
                continue
            seen.add(pair_key)
            pairs.append(
                {
                    "schema_version": "dpo.v1",
                    "prompt_messages": rejected["messages"],
                    "chosen": chosen_answer,
                    "rejected": rejected["answer"],
                    "metadata": {
                        "source": source,
                        "base_model": "",
                        "judge_provider": "hybrid",
                        "reason_tags": reason_tags,
                        "session_id": rejected["session_id"],
                        "pair_confidence": confidence,
                    },
                }
            )
    return pairs


def main() -> None:
    parser = argparse.ArgumentParser(description="Build DPO pairs from judged rows and reviewed sessions.")
    parser.add_argument("--chosen-jsonl", default="artifacts/curation/session_candidates.accepted.jsonl")
    parser.add_argument("--rejected-jsonl", default="artifacts/curation/session_candidates.rejected.jsonl")
    parser.add_argument("--reviewed-session-dir", default="artifacts/session_exports")
    parser.add_argument("--sampled-completions-jsonl", default="artifacts/curation/sft_completion_samples.jsonl")
    parser.add_argument("--output", default="artifacts/finetune/interview_pairs.dpo.v1.jsonl")
    parser.add_argument("--report", default="artifacts/finetune/interview_pairs.dpo_report.json")
    args = parser.parse_args()

    chosen_rows = parse_jsonl(Path(args.chosen_jsonl).resolve())
    rejected_rows = parse_jsonl(Path(args.rejected_jsonl).resolve())
    reviewed_map = index_reviewed_assists(Path(args.reviewed_session_dir).resolve())
    sampled_map = load_sampled_completions(Path(args.sampled_completions_jsonl).resolve())

    legacy_pairs = pair_from_legacy_rows(chosen_rows, rejected_rows)
    session_pairs = build_session_pairs(reviewed_map, sampled_map)
    pairs = legacy_pairs + session_pairs

    output_path = Path(args.output).resolve()
    report_path = Path(args.report).resolve()
    write_jsonl(output_path, pairs)
    write_json(
        report_path,
        {
            "ok": True,
            "chosen_rows": len(chosen_rows),
            "rejected_rows": len(rejected_rows),
            "reviewed_session_prompts": len(reviewed_map),
            "sampled_prompt_keys": len(sampled_map),
            "legacy_pairs": len(legacy_pairs),
            "session_pairs": len(session_pairs),
            "pairs": len(pairs),
            "output": str(output_path),
        },
    )
    print(json.dumps({"ok": True, "pairs": len(pairs), "output": str(output_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
