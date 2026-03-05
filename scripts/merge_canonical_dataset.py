#!/usr/bin/env python3
"""Merge canonical `sft.v2` JSONL sources into a single train/valid split."""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

from training_common import normalize_key, parse_jsonl, write_json, write_jsonl


def prompt_key(row: dict[str, Any]) -> str:
    messages = row.get("messages") or []
    user_content = ""
    answer = ""
    for message in messages:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "user":
            user_content = str(message.get("content") or "")
        elif message.get("role") == "assistant":
            answer = str(message.get("content") or "")
    return normalize_key(f"{user_content}|{answer}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge canonical SFT JSONL files.")
    parser.add_argument("--input-jsonl", action="append", default=[])
    parser.add_argument("--output-train", default="artifacts/finetune/interview_train.sft.v2.merged.jsonl")
    parser.add_argument("--output-valid", default="artifacts/finetune/interview_train.sft.v2.merged.valid.jsonl")
    parser.add_argument("--report", default="artifacts/finetune/interview_dataset_merge_report.json")
    parser.add_argument("--valid-ratio", type=float, default=0.08)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    input_paths = [Path(item).resolve() for item in args.input_jsonl if str(item).strip()]
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    source_counter: dict[str, int] = {}
    for path in input_paths:
        for row in parse_jsonl(path):
            if str(row.get("schema_version") or "") != "sft.v2":
                continue
            key = prompt_key(row)
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
            metadata = row.get("metadata") or {}
            source = str(metadata.get("source_bucket") or metadata.get("source") or path.stem)
            source_counter[source] = source_counter.get(source, 0) + 1

    rng = random.Random(args.seed)
    rng.shuffle(rows)
    valid_size = max(1, int(len(rows) * min(max(args.valid_ratio, 0.0), 0.4))) if len(rows) > 1 else 0
    valid_rows = rows[:valid_size]
    train_rows = rows[valid_size:] if valid_size else rows
    if not train_rows:
        train_rows = valid_rows[:]
        valid_rows = []

    output_train = Path(args.output_train).resolve()
    output_valid = Path(args.output_valid).resolve()
    report_path = Path(args.report).resolve()
    write_jsonl(output_train, train_rows)
    write_jsonl(output_valid, valid_rows)
    write_json(
        report_path,
        {
            "ok": True,
            "inputs": [str(path) for path in input_paths],
            "output_train": str(output_train),
            "output_valid": str(output_valid),
            "records_train": len(train_rows),
            "records_valid": len(valid_rows),
            "source_counter": source_counter,
        },
    )
    print(json.dumps({"ok": True, "train": len(train_rows), "valid": len(valid_rows)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
