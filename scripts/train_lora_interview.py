#!/usr/bin/env python3
"""Prepare and optionally run local LoRA training for Interview Copilot."""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any

from training_common import locate_python, write_json

PROFILE_PRESETS: dict[str, dict[str, Any]] = {
    "llama8b_sft_stable": {
        "family": "llama8b",
        "tier": "stable",
        "base_model": "meta-llama/Llama-3.1-8B-Instruct",
        "lora_r": 32,
        "lora_alpha": 64,
        "lora_dropout": 0.05,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 32,
        "learning_rate": 1.2e-4,
        "max_seq_length": 768,
        "target_modules": "all-linear",
        "load_in_4bit": True,
        "gradient_checkpointing": True,
        "flash_attention": True,
        "cpu_offload": False,
    },
    "llama8b_sft_aggressive": {
        "family": "llama8b",
        "tier": "aggressive",
        "base_model": "meta-llama/Llama-3.1-8B-Instruct",
        "lora_r": 64,
        "lora_alpha": 128,
        "lora_dropout": 0.05,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 48,
        "learning_rate": 1.0e-4,
        "max_seq_length": 512,
        "target_modules": "all-linear",
        "load_in_4bit": True,
        "gradient_checkpointing": True,
        "flash_attention": True,
        "cpu_offload": False,
    },
    "qwen7b_sft_stable": {
        "family": "qwen7b",
        "tier": "stable",
        "base_model": "Qwen/Qwen2.5-7B-Instruct",
        "lora_r": 32,
        "lora_alpha": 64,
        "lora_dropout": 0.05,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 24,
        "learning_rate": 1.4e-4,
        "max_seq_length": 1024,
        "target_modules": "all-linear",
        "load_in_4bit": True,
        "gradient_checkpointing": True,
        "flash_attention": True,
        "cpu_offload": False,
    },
    "qwen7b_sft_aggressive": {
        "family": "qwen7b",
        "tier": "aggressive",
        "base_model": "Qwen/Qwen2.5-7B-Instruct",
        "lora_r": 64,
        "lora_alpha": 128,
        "lora_dropout": 0.05,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 32,
        "learning_rate": 1.2e-4,
        "max_seq_length": 768,
        "target_modules": "all-linear",
        "load_in_4bit": True,
        "gradient_checkpointing": True,
        "flash_attention": True,
        "cpu_offload": False,
    },
}

OOM_MARKERS = ("out of memory", "cuda oom", "cublas", "allocation failed")


def line_count(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8", errors="ignore").splitlines() if line.strip())


def parse_profile_sequence(raw: str) -> list[str]:
    requested = [item.strip() for item in raw.split(",") if item.strip()]
    output: list[str] = []
    for profile in requested:
        if profile in PROFILE_PRESETS and profile not in output:
            output.append(profile)
    return output


def default_sequence(profile_family: str, profile_tier: str) -> list[str]:
    if profile_family == "qwen7b":
        profiles = ["qwen7b_sft_stable", "qwen7b_sft_aggressive"]
    else:
        profiles = ["llama8b_sft_stable", "llama8b_sft_aggressive"]
    if profile_tier == "stable":
        return [profiles[0]]
    if profile_tier == "aggressive":
        return [profiles[1], profiles[0]]
    return profiles


def default_fallback(profile_family: str) -> str | None:
    return "qwen7b_sft_stable" if profile_family == "llama8b" else None


def build_config(
    profile_name: str,
    train_path: Path,
    valid_path: Path,
    epochs: int,
    smoke_steps: int,
    run_mode: str,
    train_env: str,
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
        "adapter": "qlora",
        "dataset_format": "chatml",
        "train_env": train_env,
        **base,
    }
    if run_mode == "smoke":
        config["num_train_epochs"] = 1
        config["max_steps"] = max(20, smoke_steps)
        config["save_steps"] = max(10, smoke_steps // 4)
    if train_env == "local" and base["tier"] == "aggressive":
        config["warning"] = "Aggressive profile is intended for local smoke or Colab full training."
    return config


def build_command(config_path: Path) -> list[str]:
    python_cmd = locate_python()
    return [python_cmd, "-m", "axolotl.cli.train", "--config", str(config_path)]


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


def load_quality_report(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare LoRA interview training command template.")
    parser.add_argument(
        "--dataset",
        default="artifacts/finetune/interview_train.sft.v2.jsonl",
        help="Path to canonical train JSONL dataset.",
    )
    parser.add_argument(
        "--valid-dataset",
        default="artifacts/finetune/interview_train.sft.v2.valid.jsonl",
        help="Validation JSONL path.",
    )
    parser.add_argument("--min-records", type=int, default=1500)
    parser.add_argument("--profile-family", default="llama8b", choices=["llama8b", "qwen7b"])
    parser.add_argument("--profile-tier", default="stable", choices=["stable", "aggressive", "both"])
    parser.add_argument("--train-env", default="local", choices=["local", "colab"])
    parser.add_argument("--profile-sequence", default="")
    parser.add_argument("--fallback-profile", default="")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--smoke-steps", type=int, default=120)
    parser.add_argument("--run-smoke", action="store_true")
    parser.add_argument("--run-full", action="store_true")
    parser.add_argument(
        "--auto-fallback",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--out-dir", default="artifacts/finetune/lora_interview")
    parser.add_argument("--attempts-path", default="artifacts/finetune/training_attempts.v2.json")
    parser.add_argument(
        "--quality-report",
        default="artifacts/finetune/interview_quality_report.v2.json",
    )
    parser.add_argument(
        "--require-quality-pass",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    args = parser.parse_args()

    train_path = Path(args.dataset).resolve()
    valid_path = Path(args.valid_dataset).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    attempts_path = Path(args.attempts_path).resolve()

    train_records = line_count(train_path)
    valid_records = line_count(valid_path)
    blocked_reasons: list[str] = []
    if train_records < args.min_records:
        blocked_reasons.append(f"records_below_threshold({train_records}<{args.min_records})")

    quality_report_path = Path(args.quality_report).resolve()
    quality_payload = load_quality_report(quality_report_path)
    quality_report_summary: dict[str, Any] = {}
    if args.require_quality_pass:
        if not quality_payload:
            blocked_reasons.append(f"quality_report_missing_or_invalid({quality_report_path})")
        else:
            quality_report_summary = {
                "path": str(quality_report_path),
                "blocked": bool(quality_payload.get("blocked")),
                "blocked_reasons": quality_payload.get("blocked_reasons") or [],
                "metrics": quality_payload.get("metrics") or {},
            }
            if bool(quality_payload.get("blocked")):
                blocked_reasons.append("quality_gate_blocked")

    profile_sequence = parse_profile_sequence(args.profile_sequence) or default_sequence(
        args.profile_family, args.profile_tier
    )
    fallback_profile = args.fallback_profile.strip() or default_fallback(args.profile_family)
    if fallback_profile and fallback_profile not in PROFILE_PRESETS:
        blocked_reasons.append(f"unknown_fallback_profile({fallback_profile})")

    if args.train_env == "local" and args.run_full:
        aggressive_requested = any(PROFILE_PRESETS[name]["tier"] == "aggressive" for name in profile_sequence)
        if aggressive_requested and args.profile_family == "llama8b":
            blocked_reasons.append("local_full_train_for_aggressive_profile_not_supported")

    blocked = len(blocked_reasons) > 0
    generated: list[dict[str, Any]] = []
    for profile in profile_sequence + ([fallback_profile] if fallback_profile else []):
        if profile not in PROFILE_PRESETS:
            continue
        smoke_cfg = build_config(profile, train_path, valid_path, args.epochs, args.smoke_steps, "smoke", args.train_env)
        full_cfg = build_config(profile, train_path, valid_path, args.epochs, args.smoke_steps, "full", args.train_env)
        smoke_path = out_dir / f"train_config.{profile}.smoke.json"
        full_path = out_dir / f"train_config.{profile}.full.json"
        write_json(smoke_path, smoke_cfg)
        write_json(full_path, full_cfg)
        smoke_cmd = build_command(smoke_path)
        full_cmd = build_command(full_path)
        (out_dir / f"train_command.{profile}.smoke.txt").write_text(command_text(smoke_cmd) + "\n", encoding="utf-8")
        (out_dir / f"train_command.{profile}.full.txt").write_text(command_text(full_cmd) + "\n", encoding="utf-8")
        generated.append(
            {
                "profile": profile,
                "smoke_config": str(smoke_path),
                "full_config": str(full_path),
                "smoke_command": command_text(smoke_cmd),
                "full_command": command_text(full_cmd),
                "oom_risk": "high"
                if PROFILE_PRESETS[profile]["tier"] == "aggressive" and args.train_env == "local"
                else "medium" if PROFILE_PRESETS[profile]["tier"] == "aggressive" else "low",
            }
        )

    attempts: list[dict[str, Any]] = []
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

        if not chosen_profile and args.auto_fallback and fallback_profile:
            fallback_used = True
            smoke_config = out_dir / f"train_config.{fallback_profile}.smoke.json"
            full_config = out_dir / f"train_config.{fallback_profile}.full.json"
            smoke_cmd = build_command(smoke_config)
            full_cmd = build_command(full_config)
            smoke_result = run_command(smoke_cmd) if args.run_smoke else {"ok": True, "skipped": True}
            attempts.append(
                {
                    "profile": fallback_profile,
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
                            "profile": fallback_profile,
                            "phase": "full",
                            "result": full_result,
                            "timestamp_ms": int(time.time() * 1000),
                            "fallback": True,
                        }
                    )
                    if full_result.get("ok"):
                        chosen_profile = fallback_profile
                else:
                    chosen_profile = fallback_profile

    attempts_payload = {
        "ok": True,
        "blocked": blocked,
        "blocked_reason": blocked_reasons[0] if blocked_reasons else None,
        "blocked_reasons": blocked_reasons,
        "train_records": train_records,
        "valid_records": valid_records,
        "quality_report": quality_report_summary,
        "generated": generated,
        "attempts": attempts,
        "chosen_profile": chosen_profile,
        "fallback_used": fallback_used,
        "train_env": args.train_env,
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
                    "reasons": blocked_reasons,
                    "train_records": train_records,
                    "valid_records": valid_records,
                    "quality_report": quality_report_summary,
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
