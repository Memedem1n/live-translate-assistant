#!/usr/bin/env python3
"""Sample model completions from canonical SFT prompts for later DPO pairing."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen

from training_common import normalize_key, parse_jsonl, write_jsonl


def main() -> None:
    parser = argparse.ArgumentParser(description="Sample SFT completions for DPO mining.")
    parser.add_argument("--input-jsonl", default="artifacts/finetune/interview_train.sft.v2.jsonl")
    parser.add_argument("--base-url", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--model", required=True)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--output", default="artifacts/curation/sft_completion_samples.jsonl")
    args = parser.parse_args()

    rows = parse_jsonl(Path(args.input_jsonl).resolve())[: max(0, args.limit)]
    sampled: list[dict] = []
    endpoint = args.base_url.rstrip("/") + "/chat/completions"
    for row in rows:
        messages = row.get("messages") or []
        body = {
            "model": args.model,
            "temperature": 0,
            "messages": messages,
        }
        request = Request(
            endpoint,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8", errors="ignore"))
        content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
        sampled.append(
            {
                "schema_version": "sample.v1",
                "messages": messages,
                "prompt_key": normalize_key("\n".join(str(item.get("content") or "").strip() for item in messages if isinstance(item, dict))),
                "completion": str(content or "").strip(),
                "metadata": row.get("metadata") or {},
            }
        )
    write_jsonl(Path(args.output).resolve(), sampled)
    print(json.dumps({"ok": True, "samples": len(sampled), "output": str(Path(args.output).resolve())}, ensure_ascii=False))


if __name__ == "__main__":
    main()
