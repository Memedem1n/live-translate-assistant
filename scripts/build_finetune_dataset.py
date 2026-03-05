#!/usr/bin/env python3
"""
Build the canonical Interview Copilot English-first SFT dataset.

Outputs `sft.v2` ChatML-style JSONL files with `messages` and `metadata`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from collections import Counter
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from training_common import (
    classify_category,
    contains_first_person,
    critical_failure_tags,
    display_path,
    groundedness_score,
    normalize_key,
    normalize_text,
    parse_jsonl,
    quality_score,
    read_text,
    resolve_project_root,
    safe_float,
    sentence_count,
    speakable_answer,
    summarize_lines,
    word_count,
    write_json,
    write_jsonl,
)

AI_CATEGORIES = {"nlp_and_llm", "mlops_infra"}
BEHAVIORAL_CATEGORY = "behavioral_interview"


def iter_session_files(input_dir: Path) -> Iterable[Path]:
    if not input_dir.exists():
        return []
    for item in sorted(input_dir.glob("*.json")):
        if item.is_file():
            yield item


def make_system_prompt() -> str:
    return (
        "You are generating a speakable interview answer for the candidate. "
        "Write in first person as the candidate. "
        "Keep the answer concise, natural, and ready to speak out loud. "
        "Use 3 to 5 sentences. "
        "Do not ask a question back. "
        "Do not mention being an AI. "
        "Do not use bullet points or code blocks. "
        "Ground the answer in the provided context when available."
    )


def build_user_message(
    *,
    question: str,
    persona_summary: str,
    prior_turn_summary: str,
    context_lines: list[str],
) -> str:
    blocks: list[str] = []
    if persona_summary:
        blocks.append(f"Persona Summary:\n{persona_summary}")
    if prior_turn_summary:
        blocks.append(f"Prior Turn Summary:\n{prior_turn_summary}")
    if context_lines:
        lines = "\n".join(f"- {normalize_text(line)}" for line in context_lines if normalize_text(line))
        if lines:
            blocks.append(f"Relevant Context Lines:\n{lines}")
    blocks.append(f"Latest Interviewer Question:\n{normalize_text(question)}")
    return "\n\n".join(blocks).strip()


def build_chatml_record(
    *,
    question: str,
    answer_en: str,
    source: str,
    source_bucket: str,
    category: str,
    candidate_specific: bool,
    persona_summary: str = "",
    prior_turn_summary: str = "",
    context_lines: list[str] | None = None,
    question_tr: str = "",
    helper_answer_tr: str = "",
    external_source: str = "",
    quality: float = 0.0,
    session_id: str = "",
    transcript_ids: list[str] | None = None,
    dataset_id: str = "",
    dataset_url: str = "",
    license_name: str = "",
    rewritten_to_speakable: bool = False,
    imported_language: str = "en",
) -> dict[str, Any]:
    context_lines = [normalize_text(line) for line in (context_lines or []) if normalize_text(line)]
    metadata = {
        "source": source,
        "source_bucket": source_bucket,
        "category": category,
        "answer_style": "speakable_first_person",
        "turn_shape": "multi_turn" if prior_turn_summary else "single_turn",
        "candidate_specific": candidate_specific,
        "judge_status": "pending" if source_bucket == "session" else "not_applicable",
        "quality_score": round(float(quality), 4),
        "external_source": external_source,
        "session_id": session_id,
        "transcript_ids": transcript_ids or [],
        "context_line_count": len(context_lines),
        "question_text": normalize_text(question),
        "question_tr": normalize_text(question_tr),
        "helper_answer_tr": normalize_text(helper_answer_tr),
        "license": license_name,
        "dataset_id": dataset_id,
        "dataset_url": dataset_url,
        "rewritten_to_speakable": rewritten_to_speakable,
        "critical_failure_tags": critical_failure_tags(answer_en),
        "imported_language": imported_language,
    }
    return {
        "schema_version": "sft.v2",
        "messages": [
            {"role": "system", "content": make_system_prompt()},
            {
                "role": "user",
                "content": build_user_message(
                    question=question,
                    persona_summary=persona_summary,
                    prior_turn_summary=prior_turn_summary,
                    context_lines=context_lines,
                ),
            },
            {"role": "assistant", "content": normalize_text(answer_en)},
        ],
        "metadata": metadata,
    }


def build_glossary_answer(term: str, definition_en: str) -> str:
    definition = normalize_text(definition_en)
    if not definition:
        definition = f"{term} is an important concept in software engineering interviews."
    return (
        f"I would describe {term} as {definition} "
        f"I would then connect it to a concrete production example, explain the tradeoffs, "
        f"and mention how I would validate the decision in practice."
    )


def summarize_corpus_text(text: str, title: str) -> str:
    cleaned = normalize_text(text)
    sentences = [segment.strip() for segment in cleaned.replace("\n", " ").split(". ") if segment.strip()]
    base = ". ".join(sentences[:4]).strip()
    if not base:
        base = cleaned[:720]
    if title:
        return f"{title}. {base}"
    return base


def make_session_prior_turn_summary(
    previous_turns: list[tuple[str, str]],
    *,
    max_turns: int,
    max_chars: int,
) -> str:
    if not previous_turns:
        return ""
    selected = previous_turns[-max_turns:]
    lines = [f"Q: {normalize_text(question)} A: {normalize_text(answer)}" for question, answer in selected]
    return summarize_lines(lines, max_chars=max_chars, max_lines=max_turns)


def load_cache(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(read_text(path))
    except Exception:
        return {}
    if not isinstance(payload, dict):
        return {}
    output: dict[str, str] = {}
    for key, value in payload.items():
        if isinstance(key, str) and isinstance(value, str):
            output[key] = value
    return output


def save_cache(path: Path, payload: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def ollama_chat(
    *,
    system_prompt: str,
    user_prompt: str,
    model: str,
    base_url: str,
    timeout_sec: int,
) -> str:
    endpoint = base_url.rstrip("/") + "/api/chat"
    body = {
        "model": model,
        "stream": False,
        "options": {"temperature": 0},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    request = Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=max(5, timeout_sec)) as response:
        payload_raw = response.read().decode("utf-8", errors="ignore")
    payload = json.loads(payload_raw)
    if isinstance(payload, dict):
        message = payload.get("message")
        if isinstance(message, dict):
            content = str(message.get("content") or "").strip()
            if content:
                return content
        response_text = str(payload.get("response") or "").strip()
        if response_text:
            return response_text
    return ""


def maybe_translate_missing_english(
    *,
    source_text: str,
    existing_english: str,
    enabled: bool,
    model: str,
    base_url: str,
    timeout_sec: int,
    cache: dict[str, str],
    stats: Counter[str],
    warnings: list[str],
) -> str:
    existing_english = normalize_text(existing_english)
    if existing_english:
        return existing_english
    if not enabled:
        return ""
    source_text = normalize_text(source_text)
    if not source_text:
        return ""

    stats["requested"] += 1
    cache_key = hashlib.sha1(f"tr>en|{source_text}".encode("utf-8")).hexdigest()
    cached = cache.get(cache_key)
    if cached:
        stats["cache_hit"] += 1
        return normalize_text(cached)

    try:
        translated = ollama_chat(
            system_prompt=(
                "Translate Turkish technical interview content to English. "
                "Preserve numbers, API names, technologies, and code tokens. "
                "Return only the English text."
            ),
            user_prompt=source_text,
            model=model,
            base_url=base_url,
            timeout_sec=timeout_sec,
        )
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        stats["failed"] += 1
        warnings.append(f"translation_failed:{type(exc).__name__}")
        return ""
    except Exception as exc:
        stats["failed"] += 1
        warnings.append(f"translation_failed:unexpected:{exc}")
        return ""

    translated = normalize_text(translated)
    if not translated:
        stats["failed"] += 1
        warnings.append("translation_failed:empty")
        return ""

    cache[cache_key] = translated
    stats["generated"] += 1
    return translated


def maybe_rewrite_answer(
    *,
    question: str,
    answer: str,
    enabled: bool,
    model: str,
    base_url: str,
    timeout_sec: int,
    cache: dict[str, str],
    stats: Counter[str],
    warnings: list[str],
    min_words: int,
    max_words: int,
) -> tuple[str, bool]:
    normalized = normalize_text(answer)
    heuristic_answer, heuristic_rewritten = speakable_answer(
        normalized,
        min_words=min_words,
        max_words=max_words,
        fallback_question=question,
    )
    if not enabled:
        return heuristic_answer, heuristic_rewritten

    stats["requested"] += 1
    cache_key = hashlib.sha1(f"rewrite|{question}|{heuristic_answer}".encode("utf-8")).hexdigest()
    cached = cache.get(cache_key)
    if cached:
        stats["cache_hit"] += 1
        return normalize_text(cached), True

    try:
        rewritten = ollama_chat(
            system_prompt=(
                "Rewrite the answer into a concise first-person interview response. "
                "Use 3 to 5 sentences, keep it speakable, keep every factual claim, "
                "do not add new facts, do not use bullets, and do not ask a question back. "
                "Return only the rewritten answer."
            ),
            user_prompt=f"Question:\n{normalize_text(question)}\n\nAnswer:\n{heuristic_answer}",
            model=model,
            base_url=base_url,
            timeout_sec=timeout_sec,
        )
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        stats["failed"] += 1
        warnings.append(f"rewrite_failed:{type(exc).__name__}")
        return heuristic_answer, heuristic_rewritten
    except Exception as exc:
        stats["failed"] += 1
        warnings.append(f"rewrite_failed:unexpected:{exc}")
        return heuristic_answer, heuristic_rewritten

    rewritten = normalize_text(rewritten)
    if not rewritten:
        stats["failed"] += 1
        return heuristic_answer, heuristic_rewritten

    final_answer, _ = speakable_answer(
        rewritten,
        min_words=min_words,
        max_words=max_words,
        fallback_question=question,
    )
    cache[cache_key] = final_answer
    stats["generated"] += 1
    return final_answer, True


def extract_assistant_content(record: dict[str, Any]) -> str:
    for message in record.get("messages") or []:
        if isinstance(message, dict) and message.get("role") == "assistant":
            return normalize_text(str(message.get("content") or ""))
    return ""


def source_ratio(counter: Counter[str], key: str, total: int) -> float:
    if total <= 0:
        return 0.0
    return float(counter.get(key, 0) / total)


def should_keep_answer(answer: str, min_words: int, max_words: int) -> bool:
    if not normalize_text(answer):
        return False
    wc = word_count(answer)
    if wc < min_words or wc > max_words:
        return False
    if sentence_count(answer) < 2:
        return False
    return True


def load_prebuilt_session_candidates(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in parse_jsonl(path):
        if str(row.get("schema_version") or "").strip() != "sft.v2":
            continue
        if not isinstance(row.get("messages"), list):
            continue
        metadata = row.get("metadata")
        if not isinstance(metadata, dict):
            continue
        metadata["source"] = str(metadata.get("source") or "session")
        metadata["source_bucket"] = "session"
        rows.append(row)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Build canonical interview SFT dataset.")
    parser.add_argument("--input-dir", default=None, help="Legacy alias for --session-dir.")
    parser.add_argument("--session-dir", default="artifacts/session_exports")
    parser.add_argument("--session-candidates-jsonl", action="append", default=[])
    parser.add_argument("--corpus-jsonl", default="artifacts/corpus/web_corpus.jsonl")
    parser.add_argument("--external-qa-jsonl", action="append", default=[])
    parser.add_argument("--glossary-jsonl", default="artifacts/corpus/glossary.jsonl")
    parser.add_argument("--output", default="artifacts/finetune/interview_train.sft.v2.jsonl")
    parser.add_argument("--output-train", default="")
    parser.add_argument("--output-valid", default="")
    parser.add_argument("--report", default="artifacts/finetune/interview_dataset_report.v2.json")
    parser.add_argument("--schema-version", default="sft.v2")
    parser.add_argument("--valid-ratio", type=float, default=0.08)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--min-words-answer", type=int, default=45)
    parser.add_argument("--max-words-answer", type=int, default=140)
    parser.add_argument("--min-train-records", type=int, default=1500)
    parser.add_argument("--min-web-ratio", type=float, default=0.70)
    parser.add_argument("--max-glossary-ratio", type=float, default=0.25)
    parser.add_argument("--min-session-ratio", type=float, default=0.0)
    parser.add_argument("--min-ai-ratio", type=float, default=0.20)
    parser.add_argument("--min-behavioral-ratio", type=float, default=0.10)
    parser.add_argument("--max-behavioral-ratio", type=float, default=0.20)
    parser.add_argument("--prior-turn-window", type=int, default=2)
    parser.add_argument("--persona-summary-max-chars", type=int, default=420)
    parser.add_argument("--prior-turn-summary-max-chars", type=int, default=420)
    parser.add_argument("--context-lines-max", type=int, default=6)
    parser.add_argument(
        "--translate-en-missing",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--translation-model", default="qwen2.5:14b-instruct-q4_K_M")
    parser.add_argument("--translation-base-url", default="http://127.0.0.1:11434")
    parser.add_argument("--translation-timeout-sec", type=int, default=45)
    parser.add_argument("--translation-cache", default="artifacts/finetune/translation_cache.json")
    parser.add_argument(
        "--rewrite-speakable",
        action=argparse.BooleanOptionalAction,
        default=False,
    )
    parser.add_argument("--rewrite-model", default="qwen2.5:14b-instruct-q4_K_M")
    parser.add_argument("--rewrite-base-url", default="http://127.0.0.1:11434")
    parser.add_argument("--rewrite-timeout-sec", type=int, default=45)
    parser.add_argument("--style-cache", default="artifacts/finetune/style_rewrite_cache.json")
    parser.add_argument(
        "--enforce-source-mix",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--enforce-category-mix",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    args = parser.parse_args()

    project_root = resolve_project_root(Path(__file__))
    session_dir = Path(args.input_dir or args.session_dir).resolve()
    session_candidate_paths = [Path(item).resolve() for item in args.session_candidates_jsonl if str(item).strip()]
    corpus_path = Path(args.corpus_jsonl).resolve()
    external_paths = [Path(item).resolve() for item in args.external_qa_jsonl if str(item).strip()]
    glossary_path = Path(args.glossary_jsonl).resolve()
    train_output = Path(args.output_train or args.output).resolve()
    valid_output = (
        Path(args.output_valid).resolve()
        if args.output_valid
        else train_output.with_name(f"{train_output.stem}.valid.jsonl")
    )
    report_path = Path(args.report).resolve()
    translation_cache_path = Path(args.translation_cache).resolve()
    style_cache_path = Path(args.style_cache).resolve()

    translation_cache = load_cache(translation_cache_path)
    style_cache = load_cache(style_cache_path)
    translation_stats: Counter[str] = Counter()
    rewrite_stats: Counter[str] = Counter()
    warnings: list[str] = []
    dropped_counter: Counter[str] = Counter()
    source_counter_raw: Counter[str] = Counter()
    source_counter_final: Counter[str] = Counter()
    actual_source_counter_raw: Counter[str] = Counter()
    actual_source_counter_final: Counter[str] = Counter()
    category_counter_raw: Counter[str] = Counter()
    category_counter_final: Counter[str] = Counter()

    session_pool: list[dict[str, Any]] = []
    web_pool: list[dict[str, Any]] = []
    glossary_pool: list[dict[str, Any]] = []
    dedupe: set[str] = set()

    for candidate_path in session_candidate_paths:
        for row in load_prebuilt_session_candidates(candidate_path):
            answer = extract_assistant_content(row)
            metadata = row.get("metadata") or {}
            signature = normalize_key(f"session-prebuilt|{metadata.get('question_text') or ''}|{answer}")
            if signature in dedupe:
                dropped_counter["duplicate"] += 1
                continue
            dedupe.add(signature)
            category = str(metadata.get("category") or classify_category("", answer))
            source_counter_raw["session"] += 1
            actual_source_counter_raw[str(metadata.get("source") or "session")] += 1
            category_counter_raw[category] += 1
            session_pool.append(row)

    for session_file in iter_session_files(session_dir):
        try:
            payload = json.loads(read_text(session_file))
        except Exception:
            dropped_counter["session_parse_error"] += 1
            continue

        session_id = str(payload.get("id") or session_file.stem)
        transcripts = payload.get("transcripts") or []
        transcript_map: dict[str, dict[str, Any]] = {}
        for item in transcripts:
            if not isinstance(item, dict):
                continue
            item_id = str(item.get("id") or "")
            if item_id:
                transcript_map[item_id] = item

        assists = [item for item in (payload.get("assists") or []) if isinstance(item, dict)]
        previous_turns: list[tuple[str, str]] = []
        for assist in assists:
            if assist.get("state") != "final":
                continue
            question = normalize_text(str(assist.get("sourceText") or ""))
            transcript_id = str(assist.get("transcriptId") or "")
            if not question and transcript_id and isinstance(transcript_map.get(transcript_id), dict):
                question = normalize_text(str(transcript_map[transcript_id].get("text") or ""))

            helper_answer_tr = normalize_text(str(assist.get("helperAnswerTr") or ""))
            answer_en = maybe_translate_missing_english(
                source_text=helper_answer_tr,
                existing_english=str(assist.get("answerEn") or ""),
                enabled=bool(args.translate_en_missing),
                model=args.translation_model,
                base_url=args.translation_base_url,
                timeout_sec=args.translation_timeout_sec,
                cache=translation_cache,
                stats=translation_stats,
                warnings=warnings,
            )

            answer_en, rewritten = maybe_rewrite_answer(
                question=question,
                answer=answer_en,
                enabled=bool(args.rewrite_speakable),
                model=args.rewrite_model,
                base_url=args.rewrite_base_url,
                timeout_sec=args.rewrite_timeout_sec,
                cache=style_cache,
                stats=rewrite_stats,
                warnings=warnings,
                min_words=args.min_words_answer,
                max_words=args.max_words_answer,
            )

            if not question or not should_keep_answer(answer_en, args.min_words_answer, args.max_words_answer):
                dropped_counter["session_filter"] += 1
                continue

            context_lines = [normalize_text(line) for line in (assist.get("contextLinesUsed") or []) if normalize_text(line)]
            persona_summary = summarize_lines(
                context_lines,
                max_chars=args.persona_summary_max_chars,
                max_lines=args.context_lines_max,
            )
            prior_turn_summary = make_session_prior_turn_summary(
                previous_turns,
                max_turns=args.prior_turn_window,
                max_chars=args.prior_turn_summary_max_chars,
            )
            candidate_specific = bool(context_lines) or str(assist.get("personalizationMode") or "") == "personalized"
            category = classify_category(question, answer_en)
            quality = quality_score(
                answer_en,
                question=question,
                context_lines=context_lines,
                candidate_specific=candidate_specific,
            )
            record = build_chatml_record(
                question=question,
                answer_en=answer_en,
                source="session",
                source_bucket="session",
                category=category,
                candidate_specific=candidate_specific,
                persona_summary=persona_summary,
                prior_turn_summary=prior_turn_summary,
                context_lines=context_lines[: args.context_lines_max],
                question_tr=str(assist.get("questionTr") or ""),
                helper_answer_tr=helper_answer_tr,
                quality=quality,
                session_id=session_id,
                transcript_ids=[transcript_id] if transcript_id else [],
                rewritten_to_speakable=rewritten,
            )
            signature = normalize_key(f"session|{question}|{answer_en}")
            if signature in dedupe:
                dropped_counter["duplicate"] += 1
                continue
            dedupe.add(signature)

            session_pool.append(record)
            source_counter_raw["session"] += 1
            actual_source_counter_raw["session"] += 1
            category_counter_raw[category] += 1
            previous_turns.append((question, answer_en))

    for row in parse_jsonl(corpus_path):
        text = normalize_text(str(row.get("text") or ""))
        title = normalize_text(str(row.get("title") or "technical concept"))
        quality_hint = safe_float(row.get("quality_score"), 0.0)
        if len(text) < 900 or quality_hint < 0.35:
            dropped_counter["corpus_filter"] += 1
            continue

        language = normalize_text(str(row.get("language") or "en")).lower()
        question = (
            f"How would you explain {title} and the main engineering tradeoffs?"
            if title
            else "How would you explain this engineering concept and its tradeoffs?"
        )
        answer_seed = text if language == "en" else ""
        if language != "en":
            answer_seed = maybe_translate_missing_english(
                source_text=text,
                existing_english="",
                enabled=bool(args.translate_en_missing),
                model=args.translation_model,
                base_url=args.translation_base_url,
                timeout_sec=args.translation_timeout_sec,
                cache=translation_cache,
                stats=translation_stats,
                warnings=warnings,
            )
        answer_seed = summarize_corpus_text(answer_seed, title)
        answer_en, rewritten = maybe_rewrite_answer(
            question=question,
            answer=answer_seed,
            enabled=bool(args.rewrite_speakable),
            model=args.rewrite_model,
            base_url=args.rewrite_base_url,
            timeout_sec=args.rewrite_timeout_sec,
            cache=style_cache,
            stats=rewrite_stats,
            warnings=warnings,
            min_words=args.min_words_answer,
            max_words=args.max_words_answer,
        )
        if not should_keep_answer(answer_en, args.min_words_answer, args.max_words_answer):
            dropped_counter["corpus_filter"] += 1
            continue

        category = normalize_text(str(row.get("category") or "")) or classify_category(question, answer_en)
        quality = max(
            quality_hint,
            quality_score(answer_en, question=question, candidate_specific=False),
        )
        record = build_chatml_record(
            question=question,
            answer_en=answer_en,
            source="web_corpus",
            source_bucket="web_corpus",
            category=category,
            candidate_specific=False,
            quality=quality,
            external_source=normalize_text(str(row.get("url") or "")),
            dataset_url=normalize_text(str(row.get("url") or "")),
            imported_language=language or "en",
            rewritten_to_speakable=rewritten,
        )
        signature = normalize_key(f"web|{question}|{answer_en}")
        if signature in dedupe:
            dropped_counter["duplicate"] += 1
            continue
        dedupe.add(signature)

        web_pool.append(record)
        source_counter_raw["web_corpus"] += 1
        actual_source_counter_raw["web_corpus"] += 1
        category_counter_raw[category] += 1

    for external_path in external_paths:
        for row in parse_jsonl(external_path):
            question = normalize_text(str(row.get("question") or ""))
            answer_en = maybe_translate_missing_english(
                source_text=str(row.get("reply_tr") or ""),
                existing_english=str(row.get("reply_en") or ""),
                enabled=bool(args.translate_en_missing),
                model=args.translation_model,
                base_url=args.translation_base_url,
                timeout_sec=args.translation_timeout_sec,
                cache=translation_cache,
                stats=translation_stats,
                warnings=warnings,
            )
            answer_en, rewritten = maybe_rewrite_answer(
                question=question,
                answer=answer_en,
                enabled=bool(args.rewrite_speakable),
                model=args.rewrite_model,
                base_url=args.rewrite_base_url,
                timeout_sec=args.rewrite_timeout_sec,
                cache=style_cache,
                stats=rewrite_stats,
                warnings=warnings,
                min_words=args.min_words_answer,
                max_words=args.max_words_answer,
            )
            if not question or not should_keep_answer(answer_en, args.min_words_answer, args.max_words_answer):
                dropped_counter["external_filter"] += 1
                continue

            category = normalize_text(str(row.get("category") or "")) or classify_category(question, answer_en)
            external_source = normalize_text(str(row.get("source") or external_path.stem))
            quality_hint = safe_float(row.get("quality_score"), 0.0)
            record = build_chatml_record(
                question=question,
                answer_en=answer_en,
                source="external_qa",
                source_bucket="web_corpus",
                category=category,
                candidate_specific=False,
                helper_answer_tr=str(row.get("reply_tr") or ""),
                external_source=external_source,
                quality=max(quality_hint, quality_score(answer_en, question=question)),
                dataset_id=normalize_text(str(row.get("dataset_id") or "")),
                dataset_url=normalize_text(str(row.get("dataset_url") or "")),
                license_name=normalize_text(str(row.get("license") or "")),
                imported_language=normalize_text(str(row.get("language") or "en")) or "en",
                rewritten_to_speakable=rewritten,
            )
            signature = normalize_key(f"external|{question}|{answer_en}")
            if signature in dedupe:
                dropped_counter["duplicate"] += 1
                continue
            dedupe.add(signature)

            web_pool.append(record)
            source_counter_raw["web_corpus"] += 1
            actual_source_counter_raw["external_qa"] += 1
            category_counter_raw[category] += 1

    for row in parse_jsonl(glossary_path):
        term = normalize_text(str(row.get("term") or ""))
        if not term:
            dropped_counter["glossary_filter"] += 1
            continue
        question = f"How would you explain {term} in a technical interview?"
        answer_seed = build_glossary_answer(term, str(row.get("definition_en") or ""))
        answer_en, rewritten = maybe_rewrite_answer(
            question=question,
            answer=answer_seed,
            enabled=bool(args.rewrite_speakable),
            model=args.rewrite_model,
            base_url=args.rewrite_base_url,
            timeout_sec=args.rewrite_timeout_sec,
            cache=style_cache,
            stats=rewrite_stats,
            warnings=warnings,
            min_words=args.min_words_answer,
            max_words=args.max_words_answer,
        )
        if not should_keep_answer(answer_en, args.min_words_answer, args.max_words_answer):
            dropped_counter["glossary_filter"] += 1
            continue

        record = build_chatml_record(
            question=question,
            answer_en=answer_en,
            source="glossary",
            source_bucket="glossary",
            category="glossary",
            candidate_specific=False,
            helper_answer_tr=str(row.get("definition_tr") or ""),
            quality=quality_score(answer_en, question=question),
            license_name=normalize_text(str(row.get("license") or "")),
            rewritten_to_speakable=rewritten,
        )
        signature = normalize_key(f"glossary|{question}|{answer_en}")
        if signature in dedupe:
            dropped_counter["duplicate"] += 1
            continue
        dedupe.add(signature)

        glossary_pool.append(record)
        source_counter_raw["glossary"] += 1
        actual_source_counter_raw["glossary"] += 1
        category_counter_raw["glossary"] += 1

    save_cache(translation_cache_path, translation_cache)
    save_cache(style_cache_path, style_cache)

    rng = random.Random(args.seed)
    rng.shuffle(session_pool)
    rng.shuffle(web_pool)
    rng.shuffle(glossary_pool)

    total_available = len(session_pool) + len(web_pool) + len(glossary_pool)
    blocked = False
    blocked_reasons: list[str] = []
    if total_available == 0:
        blocked = True
        blocked_reasons.append("no_records_available")

    min_web_ratio = max(0.0, min(1.0, float(args.min_web_ratio)))
    max_glossary_ratio = max(0.0, min(1.0, float(args.max_glossary_ratio)))
    min_session_ratio = max(0.0, min(1.0, float(args.min_session_ratio)))
    target_total = total_available

    if min_web_ratio > 0 and len(web_pool) > 0:
        target_total = min(target_total, int(len(web_pool) / min_web_ratio))
    if min_session_ratio > 0 and len(session_pool) > 0:
        target_total = min(target_total, int(len(session_pool) / min_session_ratio))
    if max_glossary_ratio < 1.0:
        non_glossary_available = len(web_pool) + len(session_pool)
        if non_glossary_available > 0:
            target_total = min(target_total, int(non_glossary_available / max(1e-9, 1.0 - max_glossary_ratio)))
    target_total = max(0, min(target_total, total_available))
    if target_total <= 0 and total_available > 0:
        target_total = total_available

    mandatory_web = int(math.ceil(min_web_ratio * target_total)) if min_web_ratio > 0 else 0
    mandatory_session = int(math.ceil(min_session_ratio * target_total)) if min_session_ratio > 0 else 0
    glossary_cap = int(math.floor(max_glossary_ratio * target_total))

    if mandatory_web > len(web_pool):
        blocked = True
        blocked_reasons.append("insufficient_web_records_for_ratio")
    if mandatory_session > len(session_pool):
        blocked = True
        blocked_reasons.append("insufficient_session_records_for_ratio")

    final_rows: list[dict[str, Any]] = []
    final_rows.extend(web_pool[:mandatory_web])
    final_rows.extend(session_pool[:mandatory_session])

    web_cursor = mandatory_web
    session_cursor = mandatory_session
    glossary_cursor = 0
    glossary_added = 0
    while len(final_rows) < target_total:
        picked = False
        if session_cursor < len(session_pool):
            final_rows.append(session_pool[session_cursor])
            session_cursor += 1
            picked = True
        elif web_cursor < len(web_pool):
            final_rows.append(web_pool[web_cursor])
            web_cursor += 1
            picked = True
        elif glossary_cursor < len(glossary_pool) and glossary_added < glossary_cap:
            final_rows.append(glossary_pool[glossary_cursor])
            glossary_cursor += 1
            glossary_added += 1
            picked = True
        elif glossary_cursor < len(glossary_pool):
            glossary_cursor += 1
            continue
        if not picked:
            break

    rng.shuffle(final_rows)

    for row in final_rows:
        metadata = row.get("metadata") or {}
        source_bucket = str(metadata.get("source_bucket") or "unknown")
        source = str(metadata.get("source") or source_bucket)
        category = str(metadata.get("category") or "unknown")
        source_counter_final[source_bucket] += 1
        actual_source_counter_final[source] += 1
        category_counter_final[category] += 1

    final_total = len(final_rows)
    web_ratio = source_ratio(source_counter_final, "web_corpus", final_total)
    glossary_ratio = source_ratio(source_counter_final, "glossary", final_total)
    session_ratio = source_ratio(source_counter_final, "session", final_total)
    ai_total = sum(category_counter_final.get(category, 0) for category in AI_CATEGORIES)
    behavioral_total = category_counter_final.get(BEHAVIORAL_CATEGORY, 0)
    ai_ratio = ai_total / max(1, final_total)
    behavioral_ratio = behavioral_total / max(1, final_total)

    answers = [extract_assistant_content(row) for row in final_rows]
    quality_values = [safe_float((row.get("metadata") or {}).get("quality_score"), 0.0) for row in final_rows]
    context_grounded_values: list[float] = []
    candidate_specific_total = 0
    candidate_specific_grounded = 0
    first_person_count = 0
    speakable_count = 0
    critical_failure_rows = 0

    for row, answer in zip(final_rows, answers):
        metadata = row.get("metadata") or {}
        context_lines = []
        messages = row.get("messages") or []
        if len(messages) >= 2 and isinstance(messages[1], dict):
            user_content = str(messages[1].get("content") or "")
            for line in user_content.splitlines():
                if line.startswith("- "):
                    context_lines.append(line[2:].strip())
        grounded = groundedness_score(answer, context_lines)
        context_grounded_values.append(grounded)
        if bool(metadata.get("candidate_specific")):
            candidate_specific_total += 1
            if grounded >= 0.18:
                candidate_specific_grounded += 1
        if contains_first_person(answer):
            first_person_count += 1
        failures = critical_failure_tags(answer)
        if args.min_words_answer <= word_count(answer) <= args.max_words_answer and not failures:
            speakable_count += 1
        if failures:
            critical_failure_rows += 1

    if args.enforce_source_mix:
        if web_ratio < min_web_ratio:
            blocked = True
            blocked_reasons.append("web_ratio_below_min")
        if glossary_ratio > max_glossary_ratio + 1e-9:
            blocked = True
            blocked_reasons.append("glossary_ratio_above_max")
        if session_ratio < min_session_ratio - 1e-9:
            blocked = True
            blocked_reasons.append("session_ratio_below_min")

    if args.enforce_category_mix:
        if ai_ratio < float(args.min_ai_ratio):
            blocked = True
            blocked_reasons.append("ai_ratio_below_min")
        if behavioral_ratio < float(args.min_behavioral_ratio):
            blocked = True
            blocked_reasons.append("behavioral_ratio_below_min")
        if behavioral_ratio > float(args.max_behavioral_ratio) + 1e-9:
            blocked = True
            blocked_reasons.append("behavioral_ratio_above_max")

    valid_ratio = min(max(float(args.valid_ratio), 0.0), 0.4)
    if final_total <= 1:
        train_rows = final_rows
        valid_rows: list[dict[str, Any]] = []
    else:
        valid_size = max(1, int(final_total * valid_ratio))
        valid_rows = final_rows[:valid_size]
        train_rows = final_rows[valid_size:]
        if not train_rows:
            train_rows = valid_rows[:]
            valid_rows = []

    if len(train_rows) < int(args.min_train_records):
        blocked = True
        blocked_reasons.append(f"train_records_below_threshold({len(train_rows)}<{int(args.min_train_records)})")

    if args.schema_version != "sft.v2":
        warnings.append(f"schema_version_forced_to_sft.v2(from={args.schema_version})")

    write_jsonl(train_output, train_rows)
    write_jsonl(valid_output, valid_rows)

    report = {
        "ok": True,
        "schema_version": "sft.v2",
        "blocked": blocked,
        "blocked_reasons": blocked_reasons,
        "warnings": warnings,
        "inputs": {
            "session_dir": display_path(session_dir, project_root),
            "session_candidate_jsonl": [display_path(path, project_root) for path in session_candidate_paths],
            "corpus_jsonl": display_path(corpus_path, project_root),
            "external_qa_jsonl": [display_path(path, project_root) for path in external_paths],
            "glossary_jsonl": display_path(glossary_path, project_root),
        },
        "outputs": {
            "train": display_path(train_output, project_root),
            "valid": display_path(valid_output, project_root),
            "report": display_path(report_path, project_root),
        },
        "records_total_available": total_available,
        "records_total": final_total,
        "records_train": len(train_rows),
        "records_valid": len(valid_rows),
        "source_counter_raw": dict(source_counter_raw),
        "source_counter_final": dict(source_counter_final),
        "actual_source_counter_raw": dict(actual_source_counter_raw),
        "actual_source_counter_final": dict(actual_source_counter_final),
        "source_ratio_final": {
            "web_corpus": round(web_ratio, 4),
            "glossary": round(glossary_ratio, 4),
            "session": round(session_ratio, 4),
        },
        "category_counter_raw": dict(category_counter_raw),
        "category_counter_final": dict(category_counter_final),
        "category_ratio_final": {
            "ai_mlops": round(ai_ratio, 4),
            "behavioral_interview": round(behavioral_ratio, 4),
        },
        "quality_metrics": {
            "average_quality": round(sum(quality_values) / max(1, len(quality_values)), 4),
            "first_person_compliance": round(first_person_count / max(1, final_total), 4),
            "speakable_answer_ratio": round(speakable_count / max(1, final_total), 4),
            "candidate_specific_grounded_ratio": round(
                candidate_specific_grounded / candidate_specific_total if candidate_specific_total else 1.0,
                4,
            ),
            "candidate_specific_total": candidate_specific_total,
            "average_groundedness": round(sum(context_grounded_values) / max(1, len(context_grounded_values)), 4),
            "critical_failure_rate": round(critical_failure_rows / max(1, final_total), 4),
        },
        "translation": {
            "enabled_en": bool(args.translate_en_missing),
            "model": args.translation_model,
            "base_url": args.translation_base_url,
            "cache_path": display_path(translation_cache_path, project_root),
            "stats": dict(translation_stats),
        },
        "rewrite": {
            "enabled": bool(args.rewrite_speakable),
            "model": args.rewrite_model,
            "base_url": args.rewrite_base_url,
            "cache_path": display_path(style_cache_path, project_root),
            "stats": dict(rewrite_stats),
        },
        "constraints": {
            "min_train_records": int(args.min_train_records),
            "min_web_ratio": min_web_ratio,
            "max_glossary_ratio": max_glossary_ratio,
            "min_session_ratio": float(args.min_session_ratio),
            "min_ai_ratio": float(args.min_ai_ratio),
            "min_behavioral_ratio": float(args.min_behavioral_ratio),
            "max_behavioral_ratio": float(args.max_behavioral_ratio),
            "min_words_answer": int(args.min_words_answer),
            "max_words_answer": int(args.max_words_answer),
        },
        "dropped_counter": dict(dropped_counter),
        "seed": int(args.seed),
    }
    write_json(report_path, report)

    print(
        json.dumps(
            {
                "ok": True,
                "schema_version": "sft.v2",
                "blocked": blocked,
                "blocked_reasons": blocked_reasons,
                "output": str(train_output),
                "output_valid": str(valid_output),
                "records": final_total,
                "records_train": len(train_rows),
                "records_valid": len(valid_rows),
                "source_ratio_final": report["source_ratio_final"],
                "category_ratio_final": report["category_ratio_final"],
                "quality_metrics": report["quality_metrics"],
                "translation_stats": dict(translation_stats),
                "rewrite_stats": dict(rewrite_stats),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
