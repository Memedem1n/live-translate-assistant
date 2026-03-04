#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any


DEFAULT_INPUT = "artifacts/corpus/web_corpus.jsonl"
DEFAULT_OUTPUT = "artifacts/corpus/glossary.jsonl"
DEFAULT_SEED = "configs/glossary_seed.json"
TECH_STOPWORDS = {
    "the",
    "and",
    "that",
    "this",
    "with",
    "from",
    "into",
    "about",
    "your",
    "have",
    "what",
    "when",
    "where",
    "which",
    "there",
    "while",
    "without",
    "using",
    "used",
    "example",
    "interview",
    "question",
}


def read_text(path: Path) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1254", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="ignore")


def parse_jsonl(path: Path) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for line in read_text(path).splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            output.append(parsed)
    return output


def load_seed(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        loaded = json.loads(read_text(path))
    except Exception:
        return []
    if isinstance(loaded, list):
        return [item for item in loaded if isinstance(item, dict)]
    return []


def normalize_term(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def candidate_tokens(text: str) -> list[str]:
    raw = re.findall(r"[A-Za-z][A-Za-z0-9_+\-]{2,30}", text)
    output: list[str] = []
    for token in raw:
        lowered = token.lower()
        if lowered in TECH_STOPWORDS:
            continue
        if token.isdigit():
            continue
        output.append(token)
    return output


def build_auto_definition(term: str) -> tuple[str, str]:
    en = (
        f"{term} is a software engineering concept frequently discussed in technical interviews. "
        f"It should be explained with practical usage, tradeoffs, and production impact."
    )
    tr = (
        f"{term}, teknik mulakatlarda sik gecen bir yazilim kavramidir. "
        f"Pratik kullanim, artilar-eksiler ve uretim etkisiyle anlatilmalidir."
    )
    return en, tr


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build glossary lexicon from corpus JSONL.")
    parser.add_argument("--input", default=DEFAULT_INPUT, help="Input web corpus JSONL path")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Output glossary JSONL path")
    parser.add_argument("--seed", default=DEFAULT_SEED, help="Optional glossary seed JSON path")
    parser.add_argument("--max-terms", type=int, default=500, help="Maximum term count")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    started_at = time.time()
    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    seed_path = Path(args.seed).resolve()
    max_terms = max(1, int(args.max_terms))

    if not input_path.exists():
        print(json.dumps({"ok": False, "error": f"Input bulunamadi: {input_path}"}, ensure_ascii=False))
        return 2

    corpus_rows = parse_jsonl(input_path)
    seed_entries = load_seed(seed_path)
    term_map: dict[str, dict[str, Any]] = {}

    for item in seed_entries:
        term = normalize_term(str(item.get("term") or ""))
        if not term:
            continue
        term_map[term.lower()] = {
            "term": term,
            "definition_en": str(item.get("definition_en") or "").strip(),
            "definition_tr": str(item.get("definition_tr") or "").strip(),
            "tags": item.get("tags") if isinstance(item.get("tags"), list) else ["seed"],
            "source": str(item.get("source") or "seed").strip() or "seed",
        }

    freq: Counter[str] = Counter()
    for row in corpus_rows:
        text = str(row.get("text") or "")
        title = str(row.get("title") or "")
        for token in candidate_tokens(f"{title}\n{text[:5000]}"):
            freq[token] += 1

    for term, count in freq.most_common(max_terms * 3):
        lowered = term.lower()
        if lowered in term_map:
            continue
        if count < 4:
            break
        if len(term) < 3:
            continue

        definition_en, definition_tr = build_auto_definition(term)
        term_map[lowered] = {
            "term": term,
            "definition_en": definition_en,
            "definition_tr": definition_tr,
            "tags": ["auto", "corpus"],
            "source": "web_corpus",
            "freq": count,
        }
        if len(term_map) >= max_terms:
            break

    selected = sorted(
        term_map.values(),
        key=lambda item: (
            0 if item.get("source") == "seed" else 1,
            -int(item.get("freq") or 0),
            str(item.get("term") or "").lower(),
        ),
    )[:max_terms]

    ensure_parent(output_path)
    with output_path.open("w", encoding="utf-8") as stream:
        for item in selected:
            payload = {
                "term": item["term"],
                "definition_en": item["definition_en"],
                "definition_tr": item["definition_tr"],
                "tags": item.get("tags") or [],
                "source": item.get("source") or "web_corpus",
            }
            stream.write(json.dumps(payload, ensure_ascii=False) + "\n")

    print(
        json.dumps(
            {
                "ok": True,
                "input": str(input_path),
                "output": str(output_path),
                "terms": len(selected),
                "seed_terms": sum(1 for item in selected if item.get("source") == "seed"),
                "elapsed_ms": int((time.time() - started_at) * 1000),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
