#!/usr/bin/env python3
"""
Preload faster-whisper models so model downloads happen before demos.
"""

from __future__ import annotations

import argparse
from runtime_env import detect_cuda_runtime, load_whisper_model, prepare_runtime_environment


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

    prepared_paths = prepare_runtime_environment()
    runtime = detect_cuda_runtime()
    print(f"[prewarm] prepared runtime paths={len(prepared_paths)}")
    print(
        "[prewarm] cuda_detected="
        f"{bool(runtime.get('cublas_path'))} cuda_device_count={runtime.get('cuda_device_count', 0)} "
        f"cuda_available={runtime.get('cuda_available', False)}"
    )

    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:
        print(f"[prewarm] faster-whisper import failed: {exc}")
        print("[prewarm] Install first: pip install faster-whisper")
        return 1

    for model_name in args.models:
        print(f"[prewarm] loading {model_name} (device={args.device})")
        _model, selected_device, compute, _runtime, _errors = load_whisper_model(
            model_name=model_name,
            runtime_mode=args.device,
            compute_type="auto",
        )
        print(f"[prewarm] ready {model_name} on {selected_device}/{compute}")

    print("[prewarm] all models are ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
