#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import json
import shutil
import subprocess
import sys


def run_cmd(args: list[str]) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        return completed.returncode, (completed.stdout or completed.stderr or "").strip()
    except Exception as exc:
        return 1, str(exc)


def probe_module(module_name: str) -> dict[str, object]:
    payload: dict[str, object] = {
        "installed": False,
        "version": None,
        "error": None,
    }
    try:
        importlib.import_module(module_name)
        payload["installed"] = True
        try:
            payload["version"] = importlib.metadata.version(module_name)
        except importlib.metadata.PackageNotFoundError:
            payload["version"] = None
    except Exception as exc:
        payload["error"] = str(exc)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the train Python environment.")
    parser.add_argument("--backend", default="hf", choices=["hf"])
    args = parser.parse_args()

    payload: dict[str, object] = {
        "ok": True,
        "backend_requested": args.backend,
        "python": sys.executable,
    }

    nvidia_smi = shutil.which("nvidia-smi")
    payload["nvidia_smi"] = nvidia_smi
    if nvidia_smi:
        code, output = run_cmd([nvidia_smi, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"])
        payload["nvidia_info"] = output if code == 0 else None
        payload["nvidia_ok"] = code == 0
    else:
        payload["nvidia_ok"] = False

    try:
        import torch  # type: ignore

        payload["torch_version"] = str(torch.__version__)
        payload["cuda_available"] = bool(torch.cuda.is_available())
        payload["cuda_device_count"] = int(torch.cuda.device_count()) if torch.cuda.is_available() else 0
        payload["cuda_device_name"] = (
            str(torch.cuda.get_device_name(0)) if torch.cuda.is_available() and torch.cuda.device_count() > 0 else None
        )
    except Exception as exc:
        payload["torch_error"] = str(exc)
        payload["cuda_available"] = False
        payload["cuda_device_count"] = 0

    hf_modules = ["accelerate", "bitsandbytes", "datasets", "peft", "safetensors", "transformers", "trl"]
    hf_status = {name: probe_module(name) for name in hf_modules}
    payload["hf_modules"] = hf_status
    payload["hf_ready"] = bool(payload.get("cuda_available")) and all(
        bool(hf_status[name]["installed"]) for name in hf_modules
    )

    reasons: list[str] = []
    if not bool(payload.get("cuda_available")):
        reasons.append("cuda_unavailable")

    if not bool(payload.get("hf_ready")):
        missing = [name for name, status in hf_status.items() if not bool(status["installed"])]
        reasons.append(f"hf_deps_missing({','.join(missing)})" if missing else "hf_backend_unusable")

    payload["reasons"] = reasons
    payload["ok"] = len(reasons) == 0
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
