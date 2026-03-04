#!/usr/bin/env python3
from __future__ import annotations

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


def main() -> int:
    payload: dict[str, object] = {
        "ok": True,
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

    code, output = run_cmd([sys.executable, "-m", "pip", "show", "axolotl"])
    payload["axolotl_installed"] = code == 0
    payload["axolotl_info"] = output if code == 0 else None

    payload["ok"] = bool(payload.get("cuda_available")) and bool(payload.get("axolotl_installed"))
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
