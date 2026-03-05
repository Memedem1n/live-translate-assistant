#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare Ollama Modelfile for a LoRA adapter.")
    parser.add_argument("--base", default="llama3.1:8b-instruct-q4_K_M", help="Base Ollama model")
    parser.add_argument(
        "--adapter-dir",
        default="artifacts/finetune/lora_interview",
        help="Directory containing trained LoRA adapter files",
    )
    parser.add_argument(
        "--adapter-file",
        default="adapter_model.safetensors",
        help="Adapter file name under --adapter-dir",
    )
    parser.add_argument(
        "--out-modelfile",
        default="artifacts/finetune/lora_interview/Modelfile",
        help="Output Modelfile path",
    )
    parser.add_argument("--model-name", default="interview-copilot-lora", help="Target Ollama model name")
    parser.add_argument("--create", action="store_true", help="Run `ollama create` after writing Modelfile")
    args = parser.parse_args()

    adapter_dir = Path(args.adapter_dir).resolve()
    adapter_path = (adapter_dir / args.adapter_file).resolve()
    modelfile_path = Path(args.out_modelfile).resolve()
    modelfile_path.parent.mkdir(parents=True, exist_ok=True)

    if not adapter_path.exists():
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"Adapter dosyasi bulunamadi: {adapter_path}",
                },
                ensure_ascii=False,
            )
        )
        return 2

    modelfile = (
        f"FROM {args.base}\n"
        f"ADAPTER {adapter_path}\n"
        "PARAMETER temperature 0.2\n"
        "PARAMETER num_ctx 4096\n"
    )
    modelfile_path.write_text(modelfile, encoding="utf-8")

    payload: dict[str, object] = {
        "ok": True,
        "modelfile": str(modelfile_path),
        "model_name": args.model_name,
        "adapter": str(adapter_path),
    }

    if args.create:
        ollama_bin = shutil.which("ollama")
        if not ollama_bin:
            payload["ok"] = False
            payload["error"] = "ollama komutu bulunamadi."
            print(json.dumps(payload, ensure_ascii=False))
            return 3
        completed = subprocess.run(
            [ollama_bin, "create", args.model_name, "-f", str(modelfile_path)],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        payload["create_returncode"] = completed.returncode
        payload["create_stdout"] = (completed.stdout or "").strip()
        payload["create_stderr"] = (completed.stderr or "").strip()
        payload["ok"] = completed.returncode == 0

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

