#!/usr/bin/env python3
"""Prepare and run a Hugging Face native QLoRA SFT pipeline."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from training_common import parse_jsonl, write_json

SCRIPT_PATH = Path(__file__).resolve()
OOM_MARKERS = ("out of memory", "cuda oom", "cublas", "allocation failed")

PROFILE_PRESETS: dict[str, dict[str, Any]] = {
    "qwen3b_sft_local": {
        "base_model": "Qwen/Qwen2.5-3B-Instruct",
        "ollama_base": "qwen2.5:3b-instruct-q4_K_M",
        "lora_r": 32,
        "lora_alpha": 64,
        "lora_dropout": 0.05,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 16,
        "learning_rate": 1.4e-4,
        "max_seq_length": 768,
        "smoke_max_seq_length": 512,
        "target_modules": "all-linear",
    },
    "qwen7b_sft_local": {
        "base_model": "Qwen/Qwen2.5-7B-Instruct",
        "ollama_base": "qwen2.5:7b-instruct-q4_K_M",
        "lora_r": 32,
        "lora_alpha": 64,
        "lora_dropout": 0.05,
        "per_device_train_batch_size": 1,
        "gradient_accumulation_steps": 24,
        "learning_rate": 1.2e-4,
        "max_seq_length": 768,
        "smoke_max_seq_length": 512,
        "target_modules": "all-linear",
    },
}


def line_count(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8", errors="ignore").splitlines() if line.strip())


def load_quality_report(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def normalize_message(message: dict[str, Any]) -> dict[str, str] | None:
    role = str(message.get("role") or "").strip()
    content = str(message.get("content") or "").replace("\r\n", "\n").strip()
    if not role or not content:
        return None
    return {"role": role, "content": content}


def extract_prompt_completion(row: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    messages = row.get("messages")
    if not isinstance(messages, list) or len(messages) < 2:
        return None, "messages_missing"

    normalized_messages: list[dict[str, str]] = []
    for raw_message in messages:
        if not isinstance(raw_message, dict):
            return None, "message_not_object"
        normalized = normalize_message(raw_message)
        if normalized is None:
            return None, "message_missing_role_or_content"
        normalized_messages.append(normalized)

    if normalized_messages[-1]["role"] != "assistant":
        return None, "last_role_not_assistant"

    prompt = normalized_messages[:-1]
    completion = [normalized_messages[-1]]
    if not prompt:
        return None, "prompt_empty"

    return {
        "prompt": prompt,
        "completion": completion,
        "metadata": row.get("metadata") if isinstance(row.get("metadata"), dict) else {},
    }, None


def load_prompt_completion_rows(path: Path, sample_limit: int | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    source_rows = parse_jsonl(path)
    output_rows: list[dict[str, Any]] = []
    skipped: dict[str, int] = {}
    for row in source_rows:
        converted, reason = extract_prompt_completion(row)
        if converted is None:
            skipped[reason or "unknown"] = skipped.get(reason or "unknown", 0) + 1
            continue
        output_rows.append(converted)
        if sample_limit is not None and len(output_rows) >= sample_limit:
            break

    stats = {
        "source_rows": len(source_rows),
        "usable_rows": len(output_rows),
        "skipped_rows": sum(skipped.values()),
        "skipped_reasons": skipped,
    }
    return output_rows, stats


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


def build_command(config_path: Path, action: str) -> list[str]:
    return [sys.executable, str(SCRIPT_PATH), "--config", str(config_path), f"--{action}"]


def build_config(
    profile_name: str,
    train_path: Path,
    valid_path: Path,
    out_dir: Path,
    epochs: int,
    smoke_steps: int,
    run_mode: str,
    train_env: str,
    base_model_override: str,
) -> dict[str, Any]:
    if profile_name not in PROFILE_PRESETS:
        raise ValueError(f"Unknown profile: {profile_name}")

    preset = dict(PROFILE_PRESETS[profile_name])
    base_model = base_model_override.strip() or preset["base_model"]
    is_smoke = run_mode == "smoke"
    max_seq_length = preset["smoke_max_seq_length"] if is_smoke else preset["max_seq_length"]
    save_steps = max(10, smoke_steps // 2) if is_smoke else 150
    eval_steps = max(10, smoke_steps // 2) if is_smoke else 150
    logging_steps = max(1, smoke_steps // 5) if is_smoke else 10
    config: dict[str, Any] = {
        "backend": "hf_native",
        "profile_name": profile_name,
        "run_mode": run_mode,
        "train_env": train_env,
        "base_model": base_model,
        "ollama_base": preset["ollama_base"],
        "dataset": str(train_path),
        "valid_dataset": str(valid_path),
        "output_dir": str((out_dir / run_mode).resolve()),
        "summary_path": str((out_dir / f"train_summary.{profile_name}.{run_mode}.json").resolve()),
        "num_train_epochs": max(1, epochs),
        "max_steps": max(1, smoke_steps) if is_smoke else -1,
        "save_steps": save_steps,
        "eval_steps": eval_steps,
        "logging_steps": logging_steps,
        "warmup_ratio": 0.03,
        "learning_rate": preset["learning_rate"],
        "per_device_train_batch_size": preset["per_device_train_batch_size"],
        "per_device_eval_batch_size": 1,
        "gradient_accumulation_steps": preset["gradient_accumulation_steps"],
        "max_seq_length": max_seq_length,
        "seed": 42,
        "dtype": "auto",
        "load_in_4bit": True,
        "bnb_4bit_quant_type": "nf4",
        "bnb_4bit_use_double_quant": True,
        "gradient_checkpointing": True,
        "gradient_checkpointing_kwargs": {"use_reentrant": False},
        "optim": "paged_adamw_8bit",
        "target_modules": preset["target_modules"],
        "lora_r": preset["lora_r"],
        "lora_alpha": preset["lora_alpha"],
        "lora_dropout": preset["lora_dropout"],
        "trust_remote_code": False,
        "dataset_num_proc": 1,
        "validation_max_samples": 24 if is_smoke else 32,
    }
    return config


def load_runtime_config(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"Config JSON object expected: {path}")
    return payload


def choose_compute_dtype(dtype_preference: str) -> Any:
    import torch

    preference = (dtype_preference or "fp16").lower()
    if preference == "bf16":
        return torch.bfloat16
    if preference == "fp32":
        return torch.float32
    if preference == "auto":
        if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
            return torch.bfloat16
        return torch.float16 if torch.cuda.is_available() else torch.float32
    return torch.float16 if torch.cuda.is_available() else torch.float32


def load_tokenizer(config: dict[str, Any]) -> Any:
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(
        str(config["base_model"]),
        trust_remote_code=bool(config.get("trust_remote_code")),
        use_fast=True,
    )
    if tokenizer.pad_token is None:
        if tokenizer.eos_token is not None:
            tokenizer.pad_token = tokenizer.eos_token
        elif tokenizer.unk_token is not None:
            tokenizer.pad_token = tokenizer.unk_token
    tokenizer.padding_side = "right"
    return tokenizer


def extract_input_ids(encoded: Any) -> list[int]:
    if isinstance(encoded, dict) and "input_ids" in encoded:
        input_ids = encoded["input_ids"]
        if isinstance(input_ids, list):
            return input_ids
    if hasattr(encoded, "get") and callable(encoded.get):
        input_ids = encoded.get("input_ids")
        if isinstance(input_ids, list):
            return input_ids
    if hasattr(encoded, "ids"):
        return list(encoded.ids)
    if isinstance(encoded, list) and encoded and hasattr(encoded[0], "ids"):
        return list(encoded[0].ids)
    if isinstance(encoded, list):
        return encoded
    raise RuntimeError("Unable to read input_ids from tokenizer output.")


def tokenize_prompt_completion(row: dict[str, Any], tokenizer: Any) -> tuple[list[int], list[int]]:
    prompt_ids = extract_input_ids(tokenizer.apply_chat_template(row["prompt"], tokenize=True, add_generation_prompt=True))
    full_ids = extract_input_ids(tokenizer.apply_chat_template(row["prompt"] + row["completion"], tokenize=True))
    return prompt_ids, full_ids


def measure_completion_tokens(row: dict[str, Any], tokenizer: Any, max_length: int) -> tuple[int, int, int]:
    prompt_ids, full_ids = tokenize_prompt_completion(row, tokenizer)
    kept_completion = max(0, min(len(full_ids), max_length) - min(len(prompt_ids), max_length))
    return len(prompt_ids), len(full_ids), kept_completion


def filter_rows_with_completion_budget(
    rows: list[dict[str, Any]],
    tokenizer: Any,
    max_length: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    kept_rows: list[dict[str, Any]] = []
    dropped = 0
    for row in rows:
        _, _, kept_completion = measure_completion_tokens(row, tokenizer, max_length)
        if kept_completion <= 0:
            dropped += 1
            continue
        kept_rows.append(row)
    return kept_rows, {
        "max_length": max_length,
        "kept_rows": len(kept_rows),
        "dropped_zero_completion_rows": dropped,
    }


def validate_config(config: dict[str, Any]) -> dict[str, Any]:
    tokenizer = load_tokenizer(config)
    sample_limit = int(config.get("validation_max_samples", 24))
    rows, stats = load_prompt_completion_rows(Path(str(config["dataset"])).resolve(), sample_limit=sample_limit)
    if not rows:
        return {
            "ok": False,
            "reason": "no_usable_rows",
            "stats": stats,
        }

    prompt_lengths: list[int] = []
    completion_lengths: list[int] = []
    full_lengths: list[int] = []
    mismatches = 0
    zero_completion_after_truncation = 0
    max_length = int(config["max_seq_length"])
    for row in rows:
        prompt_ids, full_ids = tokenize_prompt_completion(row, tokenizer)
        kept_completion = max(0, min(len(full_ids), max_length) - min(len(prompt_ids), max_length))
        completion_len = max(0, len(full_ids) - len(prompt_ids))
        prompt_lengths.append(len(prompt_ids))
        completion_lengths.append(completion_len)
        full_lengths.append(len(full_ids))
        if kept_completion <= 0:
            zero_completion_after_truncation += 1
        if full_ids[: len(prompt_ids)] != prompt_ids:
            mismatches += 1

    return {
        "ok": mismatches == 0 and zero_completion_after_truncation == 0,
        "profile_name": config.get("profile_name"),
        "base_model": config.get("base_model"),
        "sample_count": len(rows),
        "tokenizer_name": getattr(tokenizer, "name_or_path", str(config["base_model"])),
        "mismatches": mismatches,
        "zero_completion_after_truncation": zero_completion_after_truncation,
        "dataset_stats": stats,
        "prompt_p50_tokens": sorted(prompt_lengths)[len(prompt_lengths) // 2],
        "completion_p50_tokens": sorted(completion_lengths)[len(completion_lengths) // 2],
        "full_p50_tokens": sorted(full_lengths)[len(full_lengths) // 2],
        "max_full_tokens": max(full_lengths),
    }


def execute_training(config: dict[str, Any]) -> dict[str, Any]:
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig, set_seed
    from trl import SFTConfig, SFTTrainer

    set_seed(int(config.get("seed", 42)))

    tokenizer = load_tokenizer(config)
    max_length = int(config["max_seq_length"])

    train_rows, train_stats = load_prompt_completion_rows(Path(str(config["dataset"])).resolve())
    train_rows, train_filter_stats = filter_rows_with_completion_budget(train_rows, tokenizer, max_length)
    if not train_rows:
        return {
            "ok": False,
            "reason": "train_dataset_empty_after_filter",
            "train_dataset_stats": train_stats,
            "train_filter_stats": train_filter_stats,
        }

    eval_dataset = None
    eval_stats: dict[str, Any] = {}
    eval_filter_stats: dict[str, Any] = {}
    valid_path = Path(str(config["valid_dataset"])).resolve()
    if valid_path.exists():
        eval_rows, eval_stats = load_prompt_completion_rows(valid_path)
        eval_rows, eval_filter_stats = filter_rows_with_completion_budget(eval_rows, tokenizer, max_length)
        if eval_rows:
            eval_dataset = Dataset.from_list(eval_rows)

    train_dataset = Dataset.from_list(train_rows)
    compute_dtype = choose_compute_dtype(str(config.get("dtype", "fp16")))
    quantization_config = BitsAndBytesConfig(
        load_in_4bit=bool(config.get("load_in_4bit", True)),
        bnb_4bit_quant_type=str(config.get("bnb_4bit_quant_type", "nf4")),
        bnb_4bit_use_double_quant=bool(config.get("bnb_4bit_use_double_quant", True)),
        bnb_4bit_compute_dtype=compute_dtype,
    )

    output_dir = Path(str(config["output_dir"])).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    model = AutoModelForCausalLM.from_pretrained(
        str(config["base_model"]),
        trust_remote_code=bool(config.get("trust_remote_code")),
        torch_dtype=compute_dtype,
        quantization_config=quantization_config,
        device_map="auto",
    )
    model.config.use_cache = False

    peft_config = LoraConfig(
        r=int(config["lora_r"]),
        lora_alpha=int(config["lora_alpha"]),
        lora_dropout=float(config["lora_dropout"]),
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=str(config["target_modules"]),
    )

    args = SFTConfig(
        output_dir=str(output_dir),
        run_name=f"{config['profile_name']}-{config['run_mode']}",
        per_device_train_batch_size=int(config["per_device_train_batch_size"]),
        per_device_eval_batch_size=int(config["per_device_eval_batch_size"]),
        gradient_accumulation_steps=int(config["gradient_accumulation_steps"]),
        num_train_epochs=float(config["num_train_epochs"]),
        max_steps=int(config["max_steps"]),
        learning_rate=float(config["learning_rate"]),
        lr_scheduler_type="cosine",
        warmup_ratio=float(config["warmup_ratio"]),
        optim=str(config["optim"]),
        logging_steps=int(config["logging_steps"]),
        save_steps=int(config["save_steps"]),
        save_strategy="steps",
        save_total_limit=2,
        eval_strategy="steps" if eval_dataset is not None else "no",
        eval_steps=int(config["eval_steps"]),
        report_to="none",
        seed=int(config["seed"]),
        dataloader_num_workers=0,
        dataset_num_proc=int(config["dataset_num_proc"]),
        gradient_checkpointing=bool(config["gradient_checkpointing"]),
        gradient_checkpointing_kwargs=config.get("gradient_checkpointing_kwargs"),
        max_length=int(config["max_seq_length"]),
        completion_only_loss=True,
        assistant_only_loss=False,
        packing=False,
        bf16=compute_dtype == torch.bfloat16,
        fp16=compute_dtype == torch.float16,
        save_only_model=True,
        remove_unused_columns=True,
    )

    trainer = SFTTrainer(
        model=model,
        args=args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        processing_class=tokenizer,
        peft_config=peft_config,
    )

    started_at = time.time()
    train_result = trainer.train()
    elapsed_ms = int((time.time() - started_at) * 1000)
    train_metrics = dict(train_result.metrics)
    train_metrics["elapsed_ms"] = elapsed_ms
    trainer.save_model(str(output_dir))
    tokenizer.save_pretrained(str(output_dir))

    eval_metrics = trainer.evaluate() if eval_dataset is not None else None
    summary_payload = {
        "ok": True,
        "backend": "hf_native",
        "profile_name": config["profile_name"],
        "run_mode": config["run_mode"],
        "base_model": config["base_model"],
        "ollama_base": config.get("ollama_base"),
        "output_dir": str(output_dir),
        "train_dataset_stats": train_stats,
        "train_filter_stats": train_filter_stats,
        "eval_dataset_stats": eval_stats,
        "eval_filter_stats": eval_filter_stats,
        "train_metrics": train_metrics,
        "eval_metrics": eval_metrics,
        "timestamp_ms": int(time.time() * 1000),
    }
    write_json(Path(str(config["summary_path"])).resolve(), summary_payload)
    return summary_payload


def run_config_action(config_path: Path, *, execute: bool, validate_only: bool) -> int:
    config = load_runtime_config(config_path)
    if validate_only:
        payload = validate_config(config)
        print(json.dumps(payload, ensure_ascii=False))
        return 0 if payload.get("ok") else 1
    if execute:
        try:
            payload = execute_training(config)
        except Exception as exc:
            payload = {
                "ok": False,
                "profile_name": config.get("profile_name"),
                "run_mode": config.get("run_mode"),
                "error": str(exc),
            }
            print(json.dumps(payload, ensure_ascii=False))
            return 1
        print(json.dumps(payload, ensure_ascii=False))
        return 0 if payload.get("ok") else 1

    print(json.dumps({"ok": True, "config": config}, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare and optionally run a HF-native QLoRA SFT training flow.")
    parser.add_argument("--config", default="", help="Prepared runtime config JSON path.")
    parser.add_argument("--execute", action="store_true", help="Execute training using --config.")
    parser.add_argument("--validate-only", action="store_true", help="Validate tokenization and dataset conversion.")
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
    parser.add_argument("--profile", default="qwen3b_sft_local", choices=sorted(PROFILE_PRESETS))
    parser.add_argument("--base-model", default="", help="Optional Hugging Face base model override.")
    parser.add_argument("--train-env", default="local", choices=["local", "colab"])
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--smoke-steps", type=int, default=30)
    parser.add_argument("--min-records", type=int, default=1500)
    parser.add_argument("--run-smoke", action="store_true")
    parser.add_argument("--run-full", action="store_true")
    parser.add_argument("--out-dir", default="artifacts/finetune/hf_qwen3b")
    parser.add_argument("--attempts-path", default="artifacts/finetune/training_attempts.hf_qwen3b.json")
    parser.add_argument("--quality-report", default="artifacts/finetune/interview_quality_report.v2.json")
    parser.add_argument(
        "--require-quality-pass",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    args = parser.parse_args()

    if args.config:
        return run_config_action(Path(args.config).resolve(), execute=args.execute, validate_only=args.validate_only)

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

    smoke_cfg = build_config(
        args.profile,
        train_path,
        valid_path,
        out_dir,
        args.epochs,
        args.smoke_steps,
        "smoke",
        args.train_env,
        args.base_model,
    )
    full_cfg = build_config(
        args.profile,
        train_path,
        valid_path,
        out_dir,
        args.epochs,
        args.smoke_steps,
        "full",
        args.train_env,
        args.base_model,
    )
    smoke_path = out_dir / f"train_config.{args.profile}.smoke.json"
    full_path = out_dir / f"train_config.{args.profile}.full.json"
    write_json(smoke_path, smoke_cfg)
    write_json(full_path, full_cfg)

    validate_command = build_command(smoke_path, "validate-only")
    smoke_command = build_command(smoke_path, "execute")
    full_command = build_command(full_path, "execute")
    (out_dir / f"train_command.{args.profile}.validate.txt").write_text(
        command_text(validate_command) + "\n",
        encoding="utf-8",
    )
    (out_dir / f"train_command.{args.profile}.smoke.txt").write_text(
        command_text(smoke_command) + "\n",
        encoding="utf-8",
    )
    (out_dir / f"train_command.{args.profile}.full.txt").write_text(
        command_text(full_command) + "\n",
        encoding="utf-8",
    )

    attempts: list[dict[str, Any]] = []
    generated = {
        "profile": args.profile,
        "validate_config": str(smoke_path),
        "smoke_config": str(smoke_path),
        "full_config": str(full_path),
        "validate_command": command_text(validate_command),
        "smoke_command": command_text(smoke_command),
        "full_command": command_text(full_command),
        "ollama_base": smoke_cfg["ollama_base"],
    }

    if not blocked_reasons:
        validate_result = run_command(validate_command)
        attempts.append(
            {
                "phase": "validate",
                "result": validate_result,
                "timestamp_ms": int(time.time() * 1000),
            }
        )
        if not validate_result.get("ok"):
            blocked_reasons.append("tokenizer_validation_failed")

    run_failed = False
    if not blocked_reasons and args.run_smoke:
        smoke_result = run_command(smoke_command)
        attempts.append(
            {
                "phase": "smoke",
                "result": smoke_result,
                "timestamp_ms": int(time.time() * 1000),
            }
        )
        if not smoke_result.get("ok"):
            run_failed = True

    if not blocked_reasons and not run_failed and args.run_full:
        full_result = run_command(full_command)
        attempts.append(
            {
                "phase": "full",
                "result": full_result,
                "timestamp_ms": int(time.time() * 1000),
            }
        )
        if not full_result.get("ok"):
            run_failed = True

    payload = {
        "ok": len(blocked_reasons) == 0 and not run_failed,
        "blocked": len(blocked_reasons) > 0,
        "blocked_reason": blocked_reasons[0] if blocked_reasons else None,
        "blocked_reasons": blocked_reasons,
        "train_records": train_records,
        "valid_records": valid_records,
        "quality_report": quality_report_summary,
        "generated": generated,
        "attempts": attempts,
        "timestamp_ms": int(time.time() * 1000),
    }
    write_json(attempts_path, payload)
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
