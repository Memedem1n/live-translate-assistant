#!/usr/bin/env python3
"""Export a self-contained train bundle for Colab or remote training."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from training_common import write_json

DEFAULT_PREP_DIR = Path("artifacts/finetune/hf_qwen3b")
PREP_PATTERNS = (
    "train_config.*.json",
    "train_command.*.txt",
    "training_attempts*.json",
)


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


def resolve_prep_source(raw_path: str) -> Path | None:
    if raw_path.strip():
        candidate = Path(raw_path).resolve()
        return candidate if candidate.exists() else None

    candidate = DEFAULT_PREP_DIR.resolve()
    return candidate if candidate.exists() else None


def collect_prep_artifacts(source: Path) -> list[Path]:
    if source.is_file():
        return [source]

    resolved: dict[str, Path] = {}
    for pattern in PREP_PATTERNS:
        for item in source.glob(pattern):
            if item.is_file():
                resolved[str(item.resolve())] = item.resolve()
    return sorted(resolved.values(), key=lambda item: item.name)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export train bundle for Colab.")
    parser.add_argument("--dataset", default="artifacts/finetune/interview_train.sft.v2.jsonl")
    parser.add_argument("--valid-dataset", default="artifacts/finetune/interview_train.sft.v2.valid.jsonl")
    parser.add_argument("--quality-report", default="artifacts/finetune/interview_quality_report.v2.json")
    parser.add_argument("--judge-config", default="configs/judge_config.json")
    parser.add_argument("--output-dir", default="artifacts/train_bundle")
    parser.add_argument(
        "--prep-dir",
        default="",
        help="Optional train prep artifact path. If omitted, artifacts/finetune/hf_qwen3b is used when present.",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    copied: list[str] = []
    maybe_copy(Path(args.dataset).resolve(), output_dir, copied)
    maybe_copy(Path(args.valid_dataset).resolve(), output_dir, copied)
    maybe_copy(Path(args.quality_report).resolve(), output_dir, copied)
    maybe_copy(Path(args.judge_config).resolve(), output_dir, copied)

    prep_source = resolve_prep_source(args.prep_dir)
    prep_copied: list[str] = []
    if prep_source is not None:
        prep_output_dir = output_dir / "train_prep"
        for item in collect_prep_artifacts(prep_source):
            maybe_copy(item, prep_output_dir, prep_copied)

    manifest_path = output_dir / "manifest.json"
    manifest: dict[str, object] = {
        "ok": True,
        "bundle_dir": str(output_dir),
        "files": copied,
    }
    if prep_source is not None:
        manifest["prep_artifacts"] = {
            "source": str(prep_source),
            "files": prep_copied,
        }
    elif args.prep_dir.strip():
        manifest["prep_artifacts"] = {
            "source": str(Path(args.prep_dir).resolve()),
            "files": [],
            "missing": True,
        }

    write_json(
        manifest_path,
        manifest,
    )
    print(
        f'{{"ok": true, "bundle_dir": "{output_dir}", "files": {len(copied)}, "prep_files": {len(prep_copied)}}}'
    )


if __name__ == "__main__":
    main()
