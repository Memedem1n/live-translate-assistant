#!/usr/bin/env python3
"""Export a self-contained train bundle for Colab or remote training."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from training_common import write_json


def maybe_copy(path: Path, output_dir: Path, copied: list[str]) -> None:
    if not path.exists():
        return
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / path.name
    if path.is_dir():
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(path, target)
    else:
        shutil.copy2(path, target)
    copied.append(str(target))


def main() -> None:
    parser = argparse.ArgumentParser(description="Export train bundle for Colab.")
    parser.add_argument("--dataset", default="artifacts/finetune/interview_train.sft.v2.jsonl")
    parser.add_argument("--valid-dataset", default="artifacts/finetune/interview_train.sft.v2.valid.jsonl")
    parser.add_argument("--quality-report", default="artifacts/finetune/interview_quality_report.v2.json")
    parser.add_argument("--judge-config", default="configs/judge_config.json")
    parser.add_argument("--output-dir", default="artifacts/train_bundle")
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    copied: list[str] = []
    maybe_copy(Path(args.dataset).resolve(), output_dir, copied)
    maybe_copy(Path(args.valid_dataset).resolve(), output_dir, copied)
    maybe_copy(Path(args.quality_report).resolve(), output_dir, copied)
    maybe_copy(Path(args.judge_config).resolve(), output_dir, copied)
    manifest_path = output_dir / "manifest.json"
    write_json(
        manifest_path,
        {
            "ok": True,
            "bundle_dir": str(output_dir),
            "files": copied,
        },
    )
    print(f'{{"ok": true, "bundle_dir": "{output_dir}", "files": {len(copied)}}}')


if __name__ == "__main__":
    main()
