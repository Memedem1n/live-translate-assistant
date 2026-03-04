#!/usr/bin/env python3
"""
Prepare and optionally run local LoRA training with 14B-first profile matrix and 7B fallback.
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any


PROFILE_PRESETS: dict[str, dict[str, Any]] = {
    "14b_ultra_lowmem_a": {
        "base_model": "Qwen/Qwen2.5-14B-Instruct",
        "lora_r": 4,
        "lora_alpha": 8,
        "lora_dropout": 0.05,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 48,
        "learning_rate": 1.5e-4,
        "max_seq_length": 640,
        "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "load_in_4bit": True,
        "gradient_checkpointing": True,
        "flash_attention": False,
    },
    "14b_ultra_lowmem_b": {
        "base_model": "Qwen/Qwen2.5-14B-Instruct",
        "lora_r": 8,
        "lora_alpha": 16,
        "lora_dropout": 0.05,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 64,
        "learning_rate": 1.2e-4,
        "max_seq_length": 512,
        "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "load_in_4bit": True,
        "gradient_checkpointing": True,
        "flash_attention": False,
    },
    "14b_offload_c": {
        "base_model": "Qwen/Qwen2.5-14B-Instruct",
        "lora_r": 8,
        "lora_alpha": 16,
        "lora_dropout": 0.08,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 80,
        "learning_rate": 1e-4,
        "max_seq_length": 448,
        "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "load_in_4bit": True,
        "gradient_checkpointing": True,
        "flash_attention": False,
        "cpu_offload": True,
    },
    "7b_fallback": {
        "base_model": "Qwen/Qwen2.5-7B-Instruct",
        "lora_r": 16,
        "lora_alpha": 32,
        "lora_dropout": 0.05,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 24,
        "learning_rate": 2e-4,
        "max_seq_length": 1024,
        "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "load_in_4bit": True,
        "gradient_checkpointing": True,
        "flash_attention": True,
    },
}

OOM_MARKERS = ("out of memory", "cuda oom", "cublas", "allocation failed")


def line_count(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8", errors="ignore").splitlines() if line.strip())


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def build_config(
    profile_name: str,
    train_path: Path,
    valid_path: Path,
    epochs: int,
    smoke_steps: int,
    run_mode: str,
) -> dict[str, Any]:
    if profile_name not in PROFILE_PRESETS:
        raise ValueError(f"Unknown profile: {profile_name}")

    base = dict(PROFILE_PRESETS[profile_name])
    config: dict[str, Any] = {
        "profile_name": profile_name,
        "dataset": str(train_path),
        "valid_dataset": str(valid_path),
        "num_train_epochs": max(1, epochs),
        "bf16": True,
        "seed": 42,
        **base,
    }
    if run_mode == "smoke":
        config["num_train_epochs"] = 1
        config["max_steps"] = max(20, smoke_steps)
        config["save_steps"] = max(10, smoke_steps // 4)
    return config


def build_command(config_path: Path) -> list[str]:
    return ["python", "-m", "axolotl.cli.train", "--config", str(config_path)]


def command_text(command: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in command)


def run_command(command: list[str], cwd: Path | None = None) -> dict[str, Any]:
    started_at = time.time()
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        cwd=str(cwd) if cwd else None,
    )
    elapsed_ms = int((time.time() - started_at) * 1000)
    stdmix = f"{completed.stdout}\n{completed.stderr}".lower()
    is_oom = any(marker in stdmix for marker in OOM_MARKERS)
    return {
        "ok": completed.returncode == 0,
        "returncode": completed.returncode,
        "elapsed_ms": elapsed_ms,
        "oom": is_oom,
        "stdout_tail": (completed.stdout or "")[-4000:],
        "stderr_tail": (completed.stderr or "")[-4000:],
    }


def parse_profile_sequence(raw: str) -> list[str]:
    requested = [item.strip() for item in raw.split(",") if item.strip()]
    output: list[str] = []
    for profile in requested:
        if profile in PROFILE_PRESETS and profile not in output:
            output.append(profile)
    if not output:
        return ["14b_ultra_lowmem_a", "14b_ultra_lowmem_b", "14b_offload_c"]
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare LoRA interview training command template.")
    parser.add_argument(
        "--dataset",
        default="artifacts/finetune/interview_train.jsonl",
        help="Path to train JSONL dataset generated by build_finetune_dataset.py",
    )
    parser.add_argument(
        "--valid-dataset",
        default="artifacts/finetune/interview_train.valid.jsonl",
        help="Validation JSONL path.",
    )
    parser.add_argument("--min-records", type=int, default=400, help="Minimum train records to start LoRA")
    parser.add_argument(
        "--profile-sequence",
        default="14b_ultra_lowmem_a,14b_ultra_lowmem_b,14b_offload_c",
        help="Comma-separated profile order for 14B attempts.",
    )
    parser.add_argument("--fallback-profile", default="7b_fallback", help="Fallback profile name.")
    parser.add_argument("--epochs", type=int, default=3, help="Full training epochs.")
    parser.add_argument("--smoke-steps", type=int, default=120, help="Smoke run max steps.")
    parser.add_argument("--run-smoke", action="store_true", help="Run smoke training for profiles.")
    parser.add_argument("--run-full", action="store_true", help="Run full training after smoke success.")
    parser.add_argument(
        "--auto-fallback",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Auto run fallback profile when 14B profiles fail.",
    )
    parser.add_argument(
        "--out-dir",
        default="artifacts/finetune/lora_interview",
        help="Output directory for training metadata",
    )
    parser.add_argument(
        "--attempts-path",
        default="artifacts/finetune/training_attempts.json",
        help="Attempt report JSON path.",
    )
    args = parser.parse_args()

    train_path = Path(args.dataset).resolve()
    valid_path = Path(args.valid_dataset).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    attempts_path = Path(args.attempts_path).resolve()

    train_records = line_count(train_path)
    valid_records = line_count(valid_path)
    blocked = train_records < args.min_records

    attempts: list[dict[str, Any]] = []
    profile_sequence = parse_profile_sequence(args.profile_sequence)

    generated: list[dict[str, Any]] = []
    for profile in profile_sequence + ([args.fallback_profile] if args.fallback_profile in PROFILE_PRESETS else []):
        smoke_cfg = build_config(profile, train_path, valid_path, args.epochs, args.smoke_steps, "smoke")
        full_cfg = build_config(profile, train_path, valid_path, args.epochs, args.smoke_steps, "full")

        smoke_path = out_dir / f"train_config.{profile}.smoke.json"
        full_path = out_dir / f"train_config.{profile}.full.json"
        write_json(smoke_path, smoke_cfg)
        write_json(full_path, full_cfg)

        smoke_cmd = build_command(smoke_path)
        full_cmd = build_command(full_path)
        (out_dir / f"train_command.{profile}.smoke.txt").write_text(
            command_text(smoke_cmd) + "\n", encoding="utf-8"
        )
        (out_dir / f"train_command.{profile}.full.txt").write_text(
            command_text(full_cmd) + "\n", encoding="utf-8"
        )
        generated.append(
            {
                "profile": profile,
                "smoke_config": str(smoke_path),
                "full_config": str(full_path),
                "smoke_command": command_text(smoke_cmd),
                "full_command": command_text(full_cmd),
            }
        )

    chosen_profile: str | None = None
    fallback_used = False

    if not blocked and (args.run_smoke or args.run_full):
        for profile in profile_sequence:
            smoke_config = out_dir / f"train_config.{profile}.smoke.json"
            full_config = out_dir / f"train_config.{profile}.full.json"
            smoke_cmd = build_command(smoke_config)
            full_cmd = build_command(full_config)

            smoke_result = run_command(smoke_cmd) if args.run_smoke else {"ok": True, "skipped": True}
            attempts.append(
                {
                    "profile": profile,
                    "phase": "smoke",
                    "result": smoke_result,
                    "timestamp_ms": int(time.time() * 1000),
                }
            )

            if not smoke_result.get("ok"):
                continue

            if args.run_full:
                full_result = run_command(full_cmd)
                attempts.append(
                    {
                        "profile": profile,
                        "phase": "full",
                        "result": full_result,
                        "timestamp_ms": int(time.time() * 1000),
                    }
                )
                if full_result.get("ok"):
                    chosen_profile = profile
                    break
            else:
                chosen_profile = profile
                break

        if not chosen_profile and args.auto_fallback and args.fallback_profile in PROFILE_PRESETS:
            fallback_used = True
            profile = args.fallback_profile
            smoke_config = out_dir / f"train_config.{profile}.smoke.json"
            full_config = out_dir / f"train_config.{profile}.full.json"
            smoke_cmd = build_command(smoke_config)
            full_cmd = build_command(full_config)

            smoke_result = run_command(smoke_cmd) if args.run_smoke else {"ok": True, "skipped": True}
            attempts.append(
                {
                    "profile": profile,
                    "phase": "smoke",
                    "result": smoke_result,
                    "timestamp_ms": int(time.time() * 1000),
                    "fallback": True,
                }
            )

            if smoke_result.get("ok"):
                if args.run_full:
                    full_result = run_command(full_cmd)
                    attempts.append(
                        {
                            "profile": profile,
                            "phase": "full",
                            "result": full_result,
                            "timestamp_ms": int(time.time() * 1000),
                            "fallback": True,
                        }
                    )
                    if full_result.get("ok"):
                        chosen_profile = profile
                else:
                    chosen_profile = profile

    attempts_payload = {
        "ok": True,
        "blocked": blocked,
        "blocked_reason": f"records_below_threshold({train_records}<{args.min_records})" if blocked else None,
        "train_records": train_records,
        "valid_records": valid_records,
        "generated": generated,
        "attempts": attempts,
        "chosen_profile": chosen_profile,
        "fallback_used": fallback_used,
        "timestamp_ms": int(time.time() * 1000),
    }
    write_json(attempts_path, attempts_payload)

    if blocked:
        print(
            json.dumps(
                {
                    "ok": False,
                    "blocked": True,
                    "reason": attempts_payload["blocked_reason"],
                    "train_records": train_records,
                    "valid_records": valid_records,
                    "attempts_path": str(attempts_path),
                    "generated_profiles": [item["profile"] for item in generated],
                },
                ensure_ascii=False,
            )
        )
        return

    print(
        json.dumps(
            {
                "ok": True,
                "blocked": False,
                "train_records": train_records,
                "valid_records": valid_records,
                "attempts_path": str(attempts_path),
                "generated_profiles": [item["profile"] for item in generated],
                "chosen_profile": chosen_profile,
                "fallback_used": fallback_used,
                "ran": bool(args.run_smoke or args.run_full),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
