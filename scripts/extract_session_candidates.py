#!/usr/bin/env python3
"""Extract session-derived SFT candidates from Interview Copilot session exports."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from build_finetune_dataset import (
    build_chatml_record,
    iter_session_files,
    make_session_prior_turn_summary,
    maybe_rewrite_answer,
    maybe_translate_missing_english,
    should_keep_answer,
)
from training_common import (
    classify_category,
    normalize_key,
    normalize_text,
    quality_score,
    read_text,
    summarize_lines,
    write_json,
    write_jsonl,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract session-only SFT candidates.")
    parser.add_argument("--session-dir", default="artifacts/session_exports")
    parser.add_argument("--output", default="artifacts/curation/session_candidates.jsonl")
    parser.add_argument("--report", default="artifacts/curation/session_candidates_report.json")
    parser.add_argument("--prior-turn-window", type=int, default=2)
    parser.add_argument("--persona-summary-max-chars", type=int, default=420)
    parser.add_argument("--prior-turn-summary-max-chars", type=int, default=420)
    parser.add_argument("--context-lines-max", type=int, default=6)
    parser.add_argument("--min-words-answer", type=int, default=45)
    parser.add_argument("--max-words-answer", type=int, default=140)
    parser.add_argument("--translate-en-missing", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--translation-model", default="qwen2.5:14b-instruct-q4_K_M")
    parser.add_argument("--translation-base-url", default="http://127.0.0.1:11434")
    parser.add_argument("--translation-timeout-sec", type=int, default=45)
    parser.add_argument("--translation-cache", default="artifacts/finetune/translation_cache.json")
    parser.add_argument("--rewrite-speakable", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--rewrite-model", default="qwen2.5:14b-instruct-q4_K_M")
    parser.add_argument("--rewrite-base-url", default="http://127.0.0.1:11434")
    parser.add_argument("--rewrite-timeout-sec", type=int, default=45)
    parser.add_argument("--style-cache", default="artifacts/finetune/style_rewrite_cache.json")
    args = parser.parse_args()

    from build_finetune_dataset import load_cache, save_cache

    session_dir = Path(args.session_dir).resolve()
    output_path = Path(args.output).resolve()
    report_path = Path(args.report).resolve()
    translation_cache = load_cache(Path(args.translation_cache).resolve())
    style_cache = load_cache(Path(args.style_cache).resolve())
    translation_stats: Counter[str] = Counter()
    rewrite_stats: Counter[str] = Counter()
    warnings: list[str] = []
    rows: list[dict] = []
    dedupe: set[str] = set()
    session_count = 0

    def stat_inc(bucket: Counter[str], key: str) -> None:
        bucket[key] = int(bucket.get(key, 0)) + 1

    for session_file in iter_session_files(session_dir):
        session_count += 1
        try:
            payload = json.loads(read_text(session_file))
        except Exception:
            stat_inc(translation_stats, "session_parse_error")
            continue

        session_id = str(payload.get("id") or session_file.stem)
        transcripts = payload.get("transcripts") or []
        transcript_map = {
            str(item.get("id") or ""): item for item in transcripts if isinstance(item, dict) and str(item.get("id") or "")
        }
        previous_turns: list[tuple[str, str]] = []
        for assist in payload.get("assists") or []:
            if not isinstance(assist, dict) or assist.get("state") != "final":
                continue
            question = normalize_text(str(assist.get("sourceText") or ""))
            transcript_id = str(assist.get("transcriptId") or "")
            if not question and transcript_id in transcript_map:
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
            record = build_chatml_record(
                question=question,
                answer_en=answer_en,
                source="session",
                source_bucket="session",
                category=classify_category(question, answer_en),
                candidate_specific=candidate_specific,
                persona_summary=persona_summary,
                prior_turn_summary=prior_turn_summary,
                context_lines=context_lines[: args.context_lines_max],
                question_tr=str(assist.get("questionTr") or ""),
                helper_answer_tr=helper_answer_tr,
                quality=quality_score(answer_en, question=question, context_lines=context_lines, candidate_specific=candidate_specific),
                session_id=session_id,
                transcript_ids=[transcript_id] if transcript_id else [],
                rewritten_to_speakable=rewritten,
            )
            key = normalize_key(f"{question}|{answer_en}")
            if key in dedupe:
                continue
            dedupe.add(key)
            rows.append(record)
            previous_turns.append((question, answer_en))

    save_cache(Path(args.translation_cache).resolve(), translation_cache)
    save_cache(Path(args.style_cache).resolve(), style_cache)
    write_jsonl(output_path, rows)
    write_json(
        report_path,
        {
            "ok": True,
            "session_dir": str(session_dir),
            "output": str(output_path),
            "sessions_seen": session_count,
            "records": len(rows),
            "translation_stats": translation_stats,
            "rewrite_stats": rewrite_stats,
            "warnings": warnings,
        },
    )
    print(json.dumps({"ok": True, "output": str(output_path), "records": len(rows)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
