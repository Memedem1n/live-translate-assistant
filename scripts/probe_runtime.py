#!/usr/bin/env python3
"""
Runtime probe utility for CUDA + faster-whisper environment diagnostics.
"""

from __future__ import annotations

import argparse
import json
from typing import Any, Dict

from runtime_env import detect_cuda_runtime, load_whisper_model, prepare_runtime_environment


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe local CUDA and whisper runtime readiness.")
    parser.add_argument("--model", default="small.en", help="Whisper model used for init check.")
    parser.add_argument(
        "--runtime-mode",
        default="auto",
        choices=["auto", "cuda", "cpu"],
        help="Requested runtime mode for model init.",
    )
    parser.add_argument(
        "--skip-model-load",
        action="store_true",
        help="Only print environment diagnostics without loading a model.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON only.",
    )
    args = parser.parse_args()

    prepared = prepare_runtime_environment()
    runtime = detect_cuda_runtime()

    result: Dict[str, Any] = {
        "prepared_paths": prepared,
        "runtime": runtime,
        "model_check": {
            "model": args.model,
            "runtime_mode": args.runtime_mode,
            "ok": None,
            "resolved_device": None,
            "compute_type": None,
            "error": None,
        },
    }

    if not args.skip_model_load:
        try:
            _model, device, compute, _runtime, _errors = load_whisper_model(
                model_name=args.model,
                runtime_mode=args.runtime_mode,
                compute_type="auto",
            )
            result["model_check"]["ok"] = True
            result["model_check"]["resolved_device"] = device
            result["model_check"]["compute_type"] = compute
        except Exception as exc:
            result["model_check"]["ok"] = False
            result["model_check"]["error"] = str(exc)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("[probe] prepared paths:")
        for item in result["prepared_paths"]:
            print(f"  - {item}")
        print("[probe] runtime:")
        print(json.dumps(result["runtime"], ensure_ascii=False, indent=2))
        print("[probe] model check:")
        print(json.dumps(result["model_check"], ensure_ascii=False, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
