#!/usr/bin/env python3
"""Import training artifacts back into the local project tree."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from training_common import write_json


def main() -> None:
    parser = argparse.ArgumentParser(description="Import Colab training artifacts.")
    parser.add_argument("--input-dir", default="artifacts/train_bundle/results")
    parser.add_argument("--target-dir", default="artifacts/finetune/imported")
    args = parser.parse_args()

    input_dir = Path(args.input_dir).resolve()
    target_dir = Path(args.target_dir).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []

    if input_dir.exists():
        for item in input_dir.iterdir():
            target = target_dir / item.name
            if item.is_dir():
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(item, target)
            else:
                shutil.copy2(item, target)
            copied.append(str(target))

    write_json(
        target_dir / "import_report.json",
        {
            "ok": True,
            "input_dir": str(input_dir),
            "target_dir": str(target_dir),
            "copied": copied,
        },
    )
    print(f'{{"ok": true, "target_dir": "{target_dir}", "copied": {len(copied)}}}')


if __name__ == "__main__":
    main()
