#!/usr/bin/env python3
"""
Build LoRA-ready interview dataset from session exports + web corpus + glossary.

Supports source-mix constraints and emits a blocked status when constraints are not met.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, TypedDict


class Record(TypedDict):
    prompt: str
    completion: str


def iter_session_files(input_dir: Path) -> Iterable[Path]:
    if not input_dir.exists():
        return []
    for item in sorted(input_dir.glob("*.json")):
        if item.is_file():
            yield item


def read_text(path: Path) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1254", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="ignore")


def parse_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in read_text(path).splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            rows.append(parsed)
    return rows


def sentence_count(text: str):  # type: ignore[no-untyped-def]
    return len(re.findall(r"[^.!?]+[.!?]+|[^.!?]+$", text.strip()))


def word_count(text: str):  # type: ignore[no-untyped-def]
    cleaned = re.sub(r"[^\w\u00C0-\u024F'-]+", " ", text, flags=re.UNICODE).strip()
    if not cleaned:
        return 0
    return len([part for part in cleaned.split(" ") if part])


def build_record(question: str, reply_en: str, reply_tr: str) -> Record:
    prompt = (
        "Interview assistant task.\n"
        "Produce a natural spoken interview answer with practical details.\n"
        "Do not use STAR labels.\n"
        f"Question: {question.strip()}"
    )
    completion = json.dumps(
        {
            "reply_en": reply_en.strip(),
            "reply_tr": reply_tr.strip(),
        },
        ensure_ascii=False,
    )
    return {"prompt": prompt, "completion": completion}


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def summarize_text(text: str, max_sentences: int = 4) -> str:
    sentences = re.findall(r"[^.!?]+[.!?]+|[^.!?]+$", text.strip())
    picked = [s.strip() for s in sentences if len(s.strip()) >= 32][:max_sentences]
    if not picked:
        compact = re.sub(r"\s+", " ", text.strip())
        return compact[:420]
    return " ".join(picked)


def build_glossary_answer(term: str, definition_en: str) -> str:
    base = definition_en.strip()
    if not base:
        base = f"{term} is an important concept in software interviews."
    if not base.endswith((".", "!", "?")):
        base += "."
    tail = (
        f" In an interview, I explain {term} with a concrete production example, "
        "then discuss tradeoffs, failure modes, and operational impact."
    )
    return f"{base}{tail}"


def should_keep(
    question: str,
    reply_en: str,
    reply_tr: str,
    min_words_reply: int,
    max_words_reply: int,
) -> bool:
    if not question.strip():
        return False
    if not reply_en.strip() and not reply_tr.strip():
        return False
    target = reply_en.strip() or reply_tr.strip()
    wc = word_count(target)
    if wc < min_words_reply or wc > max_words_reply:
        return False
    if sentence_count(target) < 2:
        return False
    return True


def write_jsonl(path: Path, rows: list[Record]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def mix_ratio(counter: Counter[str], key: str, total: int) -> float:
    if total <= 0:
        return 0.0
    return float(counter.get(key, 0) / total)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build interview fine-tune dataset JSONL.")
    parser.add_argument(
        "--input-dir",
        default=None,
        help="Legacy alias for --session-dir (directory of exported session JSON files).",
    )
    parser.add_argument(
        "--session-dir",
        default="artifacts/session_exports",
        help="Directory containing exported session JSON files.",
    )
    parser.add_argument(
        "--corpus-jsonl",
        default="artifacts/corpus/web_corpus.jsonl",
        help="Optional web corpus JSONL path.",
    )
    parser.add_argument(
        "--glossary-jsonl",
        default="artifacts/corpus/glossary.jsonl",
        help="Optional glossary JSONL path.",
    )
    parser.add_argument(
        "--output",
        default="artifacts/finetune/interview_train.jsonl",
        help="Legacy single-output path (train split).",
    )
    parser.add_argument(
        "--output-train",
        default="",
        help="Optional explicit train output path. Defaults to --output.",
    )
    parser.add_argument(
        "--output-valid",
        default="",
        help="Optional validation output path. Defaults to <train>.valid.jsonl",
    )
    parser.add_argument("--valid-ratio", type=float, default=0.08)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--min-words-reply", type=int, default=24)
    parser.add_argument("--max-words-reply", type=int, default=230)
    parser.add_argument("--min-train-records", type=int, default=400)
    parser.add_argument("--min-web-ratio", type=float, default=0.45)
    parser.add_argument("--max-glossary-ratio", type=float, default=0.35)
    parser.add_argument("--min-session-ratio", type=float, default=0.20)
    parser.add_argument(
        "--enforce-source-mix",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable/disable strict source-mix blocking rules.",
    )
    parser.add_argument(
        "--report",
        default="artifacts/finetune/interview_dataset_report.json",
        help="Dataset summary report JSON path.",
    )
    args = parser.parse_args()

    session_dir = Path(args.input_dir or args.session_dir).resolve()
    corpus_path = Path(args.corpus_jsonl).resolve()
    glossary_path = Path(args.glossary_jsonl).resolve()
    train_output = Path(args.output_train or args.output).resolve()
    valid_output = (
        Path(args.output_valid).resolve()
        if args.output_valid
        else train_output.with_name(f"{train_output.stem}.valid.jsonl")
    )
    report_path = Path(args.report).resolve()

    source_counter_raw: Counter[str] = Counter()
    source_counter_final: Counter[str] = Counter()
    dropped_counter: Counter[str] = Counter()
    dedupe = set()

    session_pool: list[Record] = []
    web_pool: list[Record] = []
    glossary_pool: list[Record] = []

    for session_file in iter_session_files(session_dir):
        try:
            payload = json.loads(read_text(session_file))
        except Exception:
            dropped_counter["session_parse_error"] += 1
            continue

        assists = payload.get("assists") or []
        for assist in assists:
            if assist.get("state") != "final":
                continue
            question = str(assist.get("sourceText") or "").strip()
            reply_en = str(assist.get("replyEn") or "").strip()
            reply_tr = str(assist.get("replyTr") or "").strip()
            if not should_keep(question, reply_en, reply_tr, args.min_words_reply, args.max_words_reply):
                dropped_counter["session_filter"] += 1
                continue

            key = f"session|{normalize(question)}|{normalize(reply_en)}|{normalize(reply_tr)}"
            if key in dedupe:
                dropped_counter["duplicate"] += 1
                continue
            dedupe.add(key)

            session_pool.append(build_record(question, reply_en, reply_tr))
            source_counter_raw["session"] += 1

    for row in parse_jsonl(corpus_path):
        text = str(row.get("text") or "").strip()
        title = str(row.get("title") or "").strip() or "technical concept"
        quality = float(row.get("quality_score") or 0.0)
        if len(text) < 900 or quality < 0.35:
            dropped_counter["corpus_filter"] += 1
            continue

        question = f"Can you explain {title} with practical engineering tradeoffs?"
        reply_en = summarize_text(text, max_sentences=4)
        reply_tr = ""
        if not should_keep(question, reply_en, reply_tr, args.min_words_reply, args.max_words_reply):
            dropped_counter["corpus_filter"] += 1
            continue

        key = f"corpus|{normalize(question)}|{normalize(reply_en)}"
        if key in dedupe:
            dropped_counter["duplicate"] += 1
            continue
        dedupe.add(key)

        web_pool.append(build_record(question, reply_en, reply_tr))
        source_counter_raw["web_corpus"] += 1

    for row in parse_jsonl(glossary_path):
        term = str(row.get("term") or "").strip()
        definition_en = str(row.get("definition_en") or "").strip()
        definition_tr = str(row.get("definition_tr") or "").strip()
        if not term:
            dropped_counter["glossary_filter"] += 1
            continue

        question = f"What is {term}, and why does it matter in a technical interview?"
        reply_en = build_glossary_answer(term, definition_en)
        reply_tr = definition_tr
        if not should_keep(question, reply_en, reply_tr, args.min_words_reply, args.max_words_reply):
            dropped_counter["glossary_filter"] += 1
            continue

        key = f"glossary|{normalize(question)}|{normalize(reply_en)}|{normalize(reply_tr)}"
        if key in dedupe:
            dropped_counter["duplicate"] += 1
            continue
        dedupe.add(key)

        glossary_pool.append(build_record(question, reply_en, reply_tr))
        source_counter_raw["glossary"] += 1

    rng = random.Random(args.seed)
    rng.shuffle(session_pool)
    rng.shuffle(web_pool)
    rng.shuffle(glossary_pool)

    total_available = len(session_pool) + len(web_pool) + len(glossary_pool)
    blocked = False
    blocked_reasons: list[str] = []
    warnings: list[str] = []

    if total_available == 0:
        blocked = True
        blocked_reasons.append("no_records_available")

    min_web_ratio = max(0.0, min(1.0, float(args.min_web_ratio)))
    max_glossary_ratio = max(0.0, min(1.0, float(args.max_glossary_ratio)))
    min_session_ratio = max(0.0, min(1.0, float(args.min_session_ratio)))
    session_required = len(session_pool) > 0 and min_session_ratio > 0

    target_total = total_available
    if min_web_ratio > 0 and len(web_pool) > 0:
        target_total = min(target_total, int(len(web_pool) / min_web_ratio))
    if session_required:
        target_total = min(target_total, int(len(session_pool) / min_session_ratio))
    if max_glossary_ratio < 1.0:
        non_glossary_available = len(web_pool) + len(session_pool)
        max_total_from_non_glossary = int(non_glossary_available / max(1e-9, 1.0 - max_glossary_ratio))
        if max_total_from_non_glossary > 0:
            target_total = min(target_total, max_total_from_non_glossary)
    target_total = max(0, min(target_total, total_available))

    if target_total <= 0 and total_available > 0:
        target_total = total_available

    final_rows: list[tuple[str, Record]] = []
    mandatory_web = int(math.ceil(min_web_ratio * target_total)) if min_web_ratio > 0 else 0
    mandatory_session = (
        int(math.ceil(min_session_ratio * target_total)) if session_required and min_session_ratio > 0 else 0
    )

    if mandatory_web > len(web_pool):
        blocked = True
        blocked_reasons.append("insufficient_web_records_for_ratio")
    if session_required and mandatory_session > len(session_pool):
        blocked = True
        blocked_reasons.append("insufficient_session_records_for_ratio")

    final_rows.extend(("web_corpus", row) for row in web_pool[:mandatory_web])
    final_rows.extend(("session", row) for row in session_pool[:mandatory_session])
    glossary_cap = int(math.floor(max_glossary_ratio * target_total))

    web_cursor = mandatory_web
    session_cursor = mandatory_session
    glossary_cursor = 0
    glossary_added = 0

    while len(final_rows) < target_total:
        picked = False
        if web_cursor < len(web_pool):
            final_rows.append(("web_corpus", web_pool[web_cursor]))
            web_cursor += 1
            picked = True
        elif session_cursor < len(session_pool):
            final_rows.append(("session", session_pool[session_cursor]))
            session_cursor += 1
            picked = True
        elif glossary_cursor < len(glossary_pool) and glossary_added < glossary_cap:
            final_rows.append(("glossary", glossary_pool[glossary_cursor]))
            glossary_cursor += 1
            glossary_added += 1
            picked = True
        elif glossary_cursor < len(glossary_pool):
            glossary_cursor += 1
            continue
        if not picked:
            break

    if len(final_rows) < target_total:
        warnings.append("could_not_fill_target_total_with_constraints")

    trimmed_glossary = 0
    while final_rows and max_glossary_ratio < 1.0:
        glossary_indices = [idx for idx, (source, _row) in enumerate(final_rows) if source == "glossary"]
        max_allowed = int(math.floor(max_glossary_ratio * len(final_rows)))
        excess = len(glossary_indices) - max_allowed
        if excess <= 0:
            break
        drop_set = set(glossary_indices[-excess:])
        final_rows = [item for idx, item in enumerate(final_rows) if idx not in drop_set]
        trimmed_glossary += excess

    if trimmed_glossary > 0:
        warnings.append(f"glossary_rows_trimmed:{trimmed_glossary}")

    final_records = [row for _, row in final_rows]
    rng.shuffle(final_records)

    for source, _ in final_rows:
        source_counter_final[source] += 1

    final_total = len(final_records)
    web_ratio = mix_ratio(source_counter_final, "web_corpus", final_total)
    glossary_ratio = mix_ratio(source_counter_final, "glossary", final_total)
    session_ratio = mix_ratio(source_counter_final, "session", final_total)

    if args.enforce_source_mix:
        if web_ratio < min_web_ratio:
            blocked = True
            blocked_reasons.append("web_ratio_below_min")
        if glossary_ratio > max_glossary_ratio + 1e-9:
            blocked = True
            blocked_reasons.append("glossary_ratio_above_max")
        if session_required and session_ratio < min_session_ratio:
            blocked = True
            blocked_reasons.append("session_ratio_below_min")

    valid_ratio = min(max(args.valid_ratio, 0.0), 0.4)
    if len(final_records) <= 1:
        train_rows = final_records
        valid_rows: list[Record] = []
    else:
        valid_size = max(1, int(len(final_records) * valid_ratio))
        valid_rows = final_records[:valid_size]
        train_rows = final_records[valid_size:]
        if not train_rows:
            train_rows = valid_rows[:]
            valid_rows = []

    if len(train_rows) < int(args.min_train_records):
        blocked = True
        blocked_reasons.append(
            f"train_records_below_threshold({len(train_rows)}<{int(args.min_train_records)})"
        )

    write_jsonl(train_output, train_rows)
    write_jsonl(valid_output, valid_rows)

    report = {
        "ok": True,
        "blocked": blocked,
        "blocked_reasons": blocked_reasons,
        "warnings": warnings,
        "session_dir": str(session_dir),
        "corpus_jsonl": str(corpus_path),
        "glossary_jsonl": str(glossary_path),
        "output_train": str(train_output),
        "output_valid": str(valid_output),
        "records_total_available": total_available,
        "records_total": len(final_records),
        "records_train": len(train_rows),
        "records_valid": len(valid_rows),
        "source_counter_raw": dict(source_counter_raw),
        "source_counter_final": dict(source_counter_final),
        "source_ratio_final": {
            "web_corpus": round(web_ratio, 4),
            "glossary": round(glossary_ratio, 4),
            "session": round(session_ratio, 4),
        },
        "constraints": {
            "min_train_records": int(args.min_train_records),
            "min_web_ratio": min_web_ratio,
            "max_glossary_ratio": max_glossary_ratio,
            "min_session_ratio": min_session_ratio,
            "session_required": session_required,
        },
        "dropped_counter": dict(dropped_counter),
        "seed": args.seed,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        json.dumps(
            {
                "ok": True,
                "blocked": blocked,
                "blocked_reasons": blocked_reasons,
                "output": str(train_output),
                "output_valid": str(valid_output),
                "records": len(final_records),
                "records_train": len(train_rows),
                "records_valid": len(valid_rows),
                "source_counter_final": dict(source_counter_final),
                "source_ratio_final": report["source_ratio_final"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
