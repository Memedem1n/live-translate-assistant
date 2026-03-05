#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from datasets import load_dataset  # type: ignore


DEFAULT_OUTPUT = "artifacts/corpus/external_interview_qa.jsonl"
DATASET_SPECS = {
    "anthropic_interviewer": {
        "dataset_id": "Anthropic/AnthropicInterviewer",
        "license": "MIT",
        "url": "https://huggingface.co/datasets/Anthropic/AnthropicInterviewer",
    },
    "oasst1": {
        "dataset_id": "OpenAssistant/oasst1",
        "license": "Apache-2.0",
        "url": "https://huggingface.co/datasets/OpenAssistant/oasst1",
    },
    "hh_rlhf": {
        "dataset_id": "Anthropic/hh-rlhf",
        "license": "MIT",
        "url": "https://huggingface.co/datasets/Anthropic/hh-rlhf",
    },
}
AI_KEYWORDS = {
    "agent",
    "ai",
    "artifact",
    "automation",
    "chatgpt",
    "claude",
    "copilot",
    "embedding",
    "evaluation",
    "fine-tune",
    "fine tuning",
    "gpu",
    "hallucination",
    "inference",
    "llm",
    "machine learning",
    "ml",
    "mlops",
    "model",
    "prompt",
    "rag",
    "retrieval",
    "token",
    "training",
    "transformer",
    "vector",
    "ajan",
    "cikarim",
    "çıkarım",
    "egitim",
    "eğitim",
    "gomme",
    "gömme",
    "ince ayar",
    "makine ogrenmesi",
    "makine öğrenmesi",
    "vektor",
    "vektör",
    "yapay zeka",
}
BEHAVIORAL_KEYWORDS = {
    "behavioral",
    "collaboration",
    "communication",
    "conflict",
    "deadline",
    "failure",
    "feedback",
    "leader",
    "leadership",
    "manager",
    "mentor",
    "mistake",
    "pressure",
    "priority",
    "stakeholder",
    "team",
    "teammate",
    "tradeoff",
    "catisma",
    "çatışma",
    "davranissal",
    "davranışsal",
    "geri bildirim",
    "iletisim",
    "iletişim",
    "liderlik",
    "paydas",
    "paydaş",
    "takim",
    "takım",
}
SYSTEM_KEYWORDS = {
    "api",
    "architecture",
    "backend",
    "cache",
    "database",
    "distributed",
    "grpc",
    "kubernetes",
    "latency",
    "microservice",
    "queue",
    "replication",
    "rest",
    "scalability",
    "system design",
    "throughput",
    "dagitik",
    "dağıtık",
    "gecikme",
    "mimari",
    "olceklenebilirlik",
    "ölçeklenebilirlik",
    "onbellek",
    "sistem tasarimi",
    "sistem tasarımı",
    "veritabani",
    "veritabanı",
}
TURN_RE = re.compile(r"(?ms)^\s*(Assistant|AI|User):\s*(.*?)(?=^\s*(?:Assistant|AI|User):|\Z)")
HH_PAIR_RE = re.compile(r"\n\nHuman:\s*(.*?)\n\nAssistant:\s*(.*?)(?=\n\nHuman:|\Z)", re.DOTALL)


def normalize_text(value: str) -> str:
    value = value.replace("\r\n", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def word_count(value: str) -> int:
    cleaned = re.sub(r"[^\w\u00C0-\u024F'-]+", " ", value, flags=re.UNICODE).strip()
    if not cleaned:
        return 0
    return len([part for part in cleaned.split(" ") if part])


def has_domain_keyword(value: str) -> bool:
    lowered = value.lower()
    return any(token in lowered for token in AI_KEYWORDS | BEHAVIORAL_KEYWORDS | SYSTEM_KEYWORDS)


def classify_category(question: str, answer: str) -> str:
    lowered = f"{question}\n{answer}".lower()
    if any(token in lowered for token in BEHAVIORAL_KEYWORDS):
        return "behavioral_interview"
    if any(token in lowered for token in AI_KEYWORDS):
        if any(token in lowered for token in {"deployment", "gpu", "training", "serving", "latency", "inference"}):
            return "mlops_infra"
        return "nlp_and_llm"
    if any(token in lowered for token in {"auth", "oauth", "jwt", "security", "xss", "csrf"}):
        return "security_appsec"
    if any(token in lowered for token in {"database", "sql", "index", "query", "replication"}):
        return "database_engineering"
    if any(token in lowered for token in {"api", "rest", "grpc"}):
        return "backend_api"
    if any(token in lowered for token in {"system design", "architecture", "distributed", "scalability", "cache"}):
        return "system_design"
    return "coding_foundations"


def compute_quality(question: str, answer: str, category: str) -> float:
    words = word_count(answer)
    keyword_hits = 0
    lowered = f"{question}\n{answer}".lower()
    for token in AI_KEYWORDS | BEHAVIORAL_KEYWORDS | SYSTEM_KEYWORDS:
        if token in lowered:
            keyword_hits += 1

    score = 0.20
    score += min(words / 180.0, 1.0) * 0.35
    score += min(keyword_hits / 4.0, 1.0) * 0.25
    if "?" in question:
        score += 0.10
    if category in {"nlp_and_llm", "mlops_infra", "behavioral_interview"}:
        score += 0.10
    if len(answer) > 120:
        score += 0.05
    return round(max(0.0, min(0.95, score)), 4)


def should_keep(question: str, answer: str, min_words: int, max_words: int) -> bool:
    question = normalize_text(question)
    answer = normalize_text(answer)
    if not question or not answer:
        return False
    if len(question) < 12:
        return False
    words = word_count(answer)
    if words < min_words or words > max_words:
        return False
    if not has_domain_keyword(f"{question}\n{answer}"):
        return False
    return True


def build_row(
    *,
    source_name: str,
    dataset_id: str,
    dataset_url: str,
    license_name: str,
    question: str,
    reply_en: str,
    reply_tr: str,
    language: str,
    category: str,
    quality_score: float,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    question = normalize_text(question)
    reply_en = normalize_text(reply_en)
    reply_tr = normalize_text(reply_tr)
    row_id = hashlib.sha1(f"{source_name}|{question}|{reply_en}|{reply_tr}".encode("utf-8")).hexdigest()[:16]
    payload = {
        "id": row_id,
        "question": question,
        "reply_en": reply_en,
        "reply_tr": reply_tr,
        "source": source_name,
        "dataset_id": dataset_id,
        "dataset_url": dataset_url,
        "license": license_name,
        "category": category,
        "language": language,
        "quality_score": quality_score,
        "imported_at": int(time.time() * 1000),
    }
    if extra:
        payload.update(extra)
    return payload


def parse_anthropic_transcript(text: str) -> Iterable[tuple[str, str]]:
    turns = [(role, normalize_text(content)) for role, content in TURN_RE.findall(text or "")]
    for index in range(len(turns) - 1):
        role, content = turns[index]
        next_role, next_content = turns[index + 1]
        if role not in {"Assistant", "AI"}:
            continue
        if next_role != "User":
            continue
        yield content, next_content


def iter_anthropic_interviewer(min_words: int, max_words: int) -> Iterable[dict[str, Any]]:
    spec = DATASET_SPECS["anthropic_interviewer"]
    for split in ("workforce", "creatives", "scientists"):
        dataset = load_dataset(spec["dataset_id"], split=split, streaming=True)
        for row in dataset:
            transcript_id = str(row.get("transcript_id") or "")
            transcript_text = str(row.get("text") or "")
            pair_index = 0
            for question, answer in parse_anthropic_transcript(transcript_text):
                if not should_keep(question, answer, min_words=min_words, max_words=max_words):
                    continue
                category = classify_category(question, answer)
                quality_score = compute_quality(question, answer, category)
                yield build_row(
                    source_name="anthropic_interviewer",
                    dataset_id=spec["dataset_id"],
                    dataset_url=spec["url"],
                    license_name=spec["license"],
                    question=question,
                    reply_en=answer,
                    reply_tr="",
                    language="en",
                    category=category,
                    quality_score=quality_score,
                    extra={
                        "split": split,
                        "transcript_id": transcript_id,
                        "pair_index": pair_index,
                    },
                )
                pair_index += 1


def iter_oasst1(min_words: int, max_words: int) -> Iterable[dict[str, Any]]:
    spec = DATASET_SPECS["oasst1"]
    dataset = load_dataset(spec["dataset_id"], split="train")
    rows_by_id: dict[str, dict[str, Any]] = {}
    for row in dataset:
        message_id = str(row.get("message_id") or "")
        if message_id:
            rows_by_id[message_id] = dict(row)

    for row in dataset:
        if str(row.get("role") or "") != "assistant":
            continue
        if bool(row.get("deleted")):
            continue
        if row.get("review_result") is False:
            continue
        parent_id = str(row.get("parent_id") or "")
        parent = rows_by_id.get(parent_id)
        if not parent:
            continue
        if str(parent.get("role") or "") != "prompter":
            continue
        lang = str(row.get("lang") or "")
        if lang not in {"en", "tr"}:
            continue

        question = str(parent.get("text") or "")
        answer = str(row.get("text") or "")
        if not should_keep(question, answer, min_words=min_words, max_words=max_words):
            continue

        category = classify_category(question, answer)
        quality_score = compute_quality(question, answer, category)
        reply_en = answer if lang == "en" else ""
        reply_tr = answer if lang == "tr" else ""
        yield build_row(
            source_name="oasst1",
            dataset_id=spec["dataset_id"],
            dataset_url=spec["url"],
            license_name=spec["license"],
            question=question,
            reply_en=reply_en,
            reply_tr=reply_tr,
            language=lang,
            category=category,
            quality_score=quality_score,
            extra={
                "message_id": str(row.get("message_id") or ""),
                "parent_id": parent_id,
                "lang": lang,
            },
        )


def extract_hh_last_pair(text: str) -> tuple[str, str] | None:
    pairs = [(normalize_text(question), normalize_text(answer)) for question, answer in HH_PAIR_RE.findall(text or "")]
    if not pairs:
        return None
    return pairs[-1]


def iter_hh_rlhf(min_words: int, max_words: int) -> Iterable[dict[str, Any]]:
    spec = DATASET_SPECS["hh_rlhf"]
    dataset = load_dataset(spec["dataset_id"], split="train", streaming=True)
    for index, row in enumerate(dataset):
        pair = extract_hh_last_pair(str(row.get("chosen") or ""))
        if not pair:
            continue
        question, answer = pair
        if not should_keep(question, answer, min_words=min_words, max_words=max_words):
            continue

        category = classify_category(question, answer)
        quality_score = compute_quality(question, answer, category)
        yield build_row(
            source_name="hh_rlhf",
            dataset_id=spec["dataset_id"],
            dataset_url=spec["url"],
            license_name=spec["license"],
            question=question,
            reply_en=answer,
            reply_tr="",
            language="en",
            category=category,
            quality_score=quality_score,
            extra={"row_index": index},
        )


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def iter_rows_for_source(source_name: str, min_words: int, max_words: int) -> Iterable[dict[str, Any]]:
    if source_name == "anthropic_interviewer":
        return iter_anthropic_interviewer(min_words=min_words, max_words=max_words)
    if source_name == "oasst1":
        return iter_oasst1(min_words=min_words, max_words=max_words)
    if source_name == "hh_rlhf":
        return iter_hh_rlhf(min_words=min_words, max_words=max_words)
    raise ValueError(f"Unsupported source: {source_name}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Import external interview-style QA datasets into JSONL.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--sources",
        default="anthropic_interviewer,oasst1,hh_rlhf",
        help="Comma-separated external source ids.",
    )
    parser.add_argument("--max-rows-per-source", type=int, default=2500)
    parser.add_argument("--min-answer-words", type=int, default=35)
    parser.add_argument("--max-answer-words", type=int, default=320)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    output_path = Path(args.output).resolve()
    started_at = time.time()
    max_rows_per_source = max(1, int(args.max_rows_per_source))
    requested_sources = [item.strip() for item in str(args.sources or "").split(",") if item.strip()]
    requested_sources = [item for item in requested_sources if item in DATASET_SPECS]
    if not requested_sources:
        print(json.dumps({"ok": False, "error": "No supported sources selected."}, ensure_ascii=False))
        return 2

    seen_keys: set[str] = set()
    rows: list[dict[str, Any]] = []
    source_counter: Counter[str] = Counter()
    category_counter: Counter[str] = Counter()
    language_counter: Counter[str] = Counter()
    warnings: list[str] = []

    for source_name in requested_sources:
        try:
            iterator = iter_rows_for_source(
                source_name=source_name,
                min_words=max(10, int(args.min_answer_words)),
                max_words=max(40, int(args.max_answer_words)),
            )
            for row in iterator:
                key = hashlib.sha1(
                    f"{normalize_text(str(row.get('question') or ''))}|{normalize_text(str(row.get('reply_en') or ''))}".encode(
                        "utf-8"
                    )
                ).hexdigest()
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                rows.append(row)
                source_counter[source_name] += 1
                category_counter[str(row.get("category") or "unknown")] += 1
                language_counter[str(row.get("language") or "unknown")] += 1
                if source_counter[source_name] >= max_rows_per_source:
                    break
        except Exception as exc:
            warnings.append(f"source_failed:{source_name}:{type(exc).__name__}:{exc}")

    ensure_parent(output_path)
    with output_path.open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(
        json.dumps(
            {
                "ok": True,
                "output": str(output_path),
                "rows": len(rows),
                "sources": requested_sources,
                "source_counter": dict(source_counter),
                "category_counter": dict(category_counter),
                "language_counter": dict(language_counter),
                "warnings": warnings[:100],
                "elapsed_ms": int((time.time() - started_at) * 1000),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
