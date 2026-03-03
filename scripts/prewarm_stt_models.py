#!/usr/bin/env python3
"""
Preload faster-whisper models so model downloads happen before demos.
"""

from __future__ import annotations

import argparse
import ctypes.util
import os
from typing import List, Tuple


def load_model(model_name: str, device: str) -> Tuple[str, str]:
    from faster_whisper import WhisperModel

    supports_cuda = has_cuda12_runtime()

    attempts: List[Tuple[str, str]] = [("cpu", "int8")]
    if device == "auto" and supports_cuda:
        attempts = [("cuda", "int8_float16"), ("cpu", "int8")]
    elif device == "cuda" and supports_cuda:
        attempts = [("cuda", "int8_float16"), ("cpu", "int8")]

    errors: List[str] = []
    for selected_device, compute in attempts:
        try:
            WhisperModel(model_name, device=selected_device, compute_type=compute)
            return selected_device, compute
        except Exception as exc:  # pragma: no cover
            errors.append(f"{selected_device}/{compute}: {exc}")

    raise RuntimeError("Unable to preload model. " + " | ".join(errors))


def has_cuda12_runtime() -> bool:
    if ctypes.util.find_library("cublas64_12"):
        return True

    dll_name = "cublas64_12.dll"
    for raw_dir in os.environ.get("PATH", "").split(os.pathsep):
        if not raw_dir:
            continue
        candidate = os.path.join(raw_dir, dll_name)
        if os.path.exists(candidate):
            return True

    toolkit_root = r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
    if os.path.isdir(toolkit_root):
        for entry in os.listdir(toolkit_root):
            candidate = os.path.join(toolkit_root, entry, "bin", dll_name)
            if os.path.exists(candidate):
                return True

    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Preload faster-whisper model files.")
    parser.add_argument(
        "--models",
        nargs="+",
        default=["small.en", "medium.en", "large-v3"],
        help="Whisper model names to preload.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cuda", "cpu"],
        help="Preferred device strategy.",
    )
    args = parser.parse_args()

    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:
        print(f"[prewarm] faster-whisper import failed: {exc}")
        print("[prewarm] Install first: pip install faster-whisper")
        return 1

    for model_name in args.models:
        print(f"[prewarm] loading {model_name} (device={args.device})")
        selected_device, compute = load_model(model_name, args.device)
        print(f"[prewarm] ready {model_name} on {selected_device}/{compute}")

    print("[prewarm] all models are ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
