#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from typing import Any, Iterable

PROJECT_ROOT_ENV = "LIVETRANSLATE_PROJECT_ROOT"
FIRST_PERSON_RE = re.compile(r"\b(i|i'm|i’ve|i'd|i'll|my|mine|we|we've|our|ours)\b", re.IGNORECASE)
AI_DISCLAIMER_RE = re.compile(r"\b(as an ai|i cannot|i can't help with that|language model)\b", re.IGNORECASE)
QUESTION_BACK_RE = re.compile(r"\?$")
BULLET_RE = re.compile(r"^\s*(?:[-*•]|\d+\.)\s+", re.MULTILINE)
CODE_BLOCK_RE = re.compile(r"```|\bdef\s+\w+\(|\bclass\s+\w+\(|\bfunction\s+\w+\(|\{\s*$")
TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_+\-/]{2,}")
SENTENCE_RE = re.compile(r"[^.!?]+[.!?]+|[^.!?]+$")

AI_KEYWORDS = {
    "agent", "ai", "automation", "chatgpt", "claude", "copilot", "embedding", "evaluation",
    "fine-tune", "fine tuning", "gpu", "hallucination", "inference", "llm", "machine learning",
    "ml", "mlops", "model", "prompt", "rag", "retrieval", "token", "training", "transformer", "vector",
}
BEHAVIORAL_KEYWORDS = {
    "behavioral", "collaboration", "communication", "conflict", "deadline", "failure", "feedback",
    "leader", "leadership", "manager", "mentor", "mistake", "pressure", "priority", "stakeholder",
    "team", "teammate", "tradeoff",
}
SYSTEM_KEYWORDS = {
    "api", "architecture", "backend", "cache", "database", "distributed", "grpc", "kubernetes",
    "latency", "microservice", "queue", "replication", "rest", "scalability", "system design", "throughput",
}
SECURITY_KEYWORDS = {"auth", "oauth", "jwt", "security", "xss", "csrf", "owasp", "encryption", "secret"}
DB_KEYWORDS = {"database", "sql", "index", "query", "replication", "postgres", "mysql", "redis"}
BACKEND_KEYWORDS = {"api", "rest", "grpc", "http", "service", "backend", "endpoint"}


def resolve_project_root(start_path: Path | None = None) -> Path:
    env_root = Path(str(os.environ.get(PROJECT_ROOT_ENV, ""))).expanduser()
    if str(env_root).strip() and (env_root / "package.json").exists():
        return env_root.resolve()

    cursor = (start_path or Path.cwd()).resolve()
    if cursor.is_file():
        cursor = cursor.parent
    for candidate in [cursor, *cursor.parents]:
        if (candidate / "package.json").exists():
            return candidate
    return cursor


def display_path(path: Path, project_root: Path | None = None) -> str:
    path = path.resolve()
    root = (project_root or resolve_project_root(path)).resolve()
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except ValueError:
        return str(path)


def read_text(path: Path) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1254", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="ignore")


def parse_json(path: Path) -> dict[str, Any]:
    parsed = json.loads(read_text(path))
    if not isinstance(parsed, dict):
        raise RuntimeError(f"JSON object expected: {path}")
    return parsed


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


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def normalize_text(value: str) -> str:
    value = str(value or "").replace("\r\n", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def normalize_key(value: str) -> str:
    return re.sub(r"\s+", " ", normalize_text(value).lower())


def split_sentences(text: str) -> list[str]:
    return [segment.strip() for segment in SENTENCE_RE.findall(normalize_text(text)) if segment.strip()]


def sentence_count(text: str) -> int:
    return len(split_sentences(text))


def word_count(text: str) -> int:
    cleaned = re.sub(r"[^\w\u00C0-\u024F'-]+", " ", normalize_text(text), flags=re.UNICODE).strip()
    if not cleaned:
        return 0
    return len([part for part in cleaned.split(" ") if part])


def contains_first_person(text: str) -> bool:
    return bool(FIRST_PERSON_RE.search(normalize_text(text)))


def contains_ai_disclaimer(text: str) -> bool:
    return bool(AI_DISCLAIMER_RE.search(normalize_text(text)))


def is_bullet_heavy(text: str) -> bool:
    return len(BULLET_RE.findall(text or "")) >= 2


def contains_code_block(text: str) -> bool:
    return bool(CODE_BLOCK_RE.search(text or ""))


def asks_question_back(text: str) -> bool:
    trimmed = normalize_text(text)
    if not trimmed:
        return False
    last_sentence = re.split(r"(?<=[.!?])\s+", trimmed)[-1].strip()
    return bool(QUESTION_BACK_RE.search(last_sentence))


def summarize_lines(lines: Iterable[str], max_chars: int = 420, max_lines: int = 6) -> str:
    output: list[str] = []
    for line in lines:
        compact = normalize_text(line)
        if not compact:
            continue
        output.append(compact)
        if len(output) >= max_lines:
            break
    merged = " ".join(output).strip()
    return merged[:max_chars].strip()


def ensure_terminal_punctuation(text: str) -> str:
    cleaned = normalize_text(text)
    if not cleaned:
        return ""
    if cleaned[-1] not in ".!?":
        return f"{cleaned}."
    return cleaned


def trim_to_word_window(text: str, max_words: int) -> str:
    cleaned = normalize_text(text)
    if word_count(cleaned) <= max_words:
        return ensure_terminal_punctuation(cleaned)
    sentences = split_sentences(cleaned)
    selected: list[str] = []
    for sentence in sentences:
        candidate = " ".join(selected + [sentence]).strip()
        if word_count(candidate) > max_words and selected:
            break
        if word_count(candidate) > max_words:
            break
        selected.append(sentence)
    if selected:
        return ensure_terminal_punctuation(" ".join(selected))
    words = cleaned.split()
    return ensure_terminal_punctuation(" ".join(words[:max_words]))


def speakable_answer(
    answer: str,
    *,
    max_words: int = 140,
    min_words: int = 45,
    ensure_first_person: bool = True,
    fallback_question: str = "",
) -> tuple[str, bool]:
    cleaned = normalize_text(answer)
    rewritten = False
    if not cleaned and fallback_question:
        cleaned = (
            f"I would answer {normalize_text(fallback_question)} by focusing on the practical tradeoffs, the implementation details, and the outcome I delivered."
        )
        rewritten = True

    if is_bullet_heavy(cleaned):
        cleaned = re.sub(BULLET_RE, "", cleaned)
        cleaned = normalize_text(cleaned)
        rewritten = True

    if contains_code_block(cleaned):
        cleaned = re.sub(r"```.*?```", " ", cleaned, flags=re.DOTALL)
        cleaned = normalize_text(cleaned)
        rewritten = True

    if contains_ai_disclaimer(cleaned):
        cleaned = AI_DISCLAIMER_RE.sub("", cleaned)
        cleaned = normalize_text(cleaned)
        rewritten = True

    if ensure_first_person and cleaned and not contains_first_person(cleaned):
        prefix = "I would explain it this way: "
        cleaned = prefix + cleaned[:1].lower() + cleaned[1:] if len(cleaned) > 1 else prefix + cleaned
        rewritten = True

    cleaned = trim_to_word_window(cleaned, max_words=max_words)
    if asks_question_back(cleaned):
        cleaned = cleaned[:-1].rstrip() + "."
        rewritten = True

    if word_count(cleaned) < min_words:
        extension = (
            " I would keep the answer concrete by mentioning the tradeoffs, the production impact, and how I validated the result."
        )
        cleaned = trim_to_word_window(f"{cleaned} {extension}", max_words=max_words)
        rewritten = True

    return ensure_terminal_punctuation(cleaned), rewritten


def extract_tokens(text: str) -> set[str]:
    return {token.lower() for token in TOKEN_RE.findall(normalize_text(text))}


def lexical_overlap_ratio(left: str, right: str) -> float:
    left_tokens = extract_tokens(left)
    right_tokens = extract_tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens.intersection(right_tokens)) / max(1, len(left_tokens))


def groundedness_score(answer: str, context_lines: Iterable[str]) -> float:
    context = " ".join(normalize_text(line) for line in context_lines if normalize_text(line))
    if not context:
        return 1.0
    return lexical_overlap_ratio(context, answer)


def critical_failure_tags(answer: str) -> list[str]:
    tags: list[str] = []
    trimmed = normalize_text(answer)
    wc = word_count(trimmed)
    if not contains_first_person(trimmed):
        tags.append("not_first_person")
    if wc < 45:
        tags.append("too_short")
    if wc > 140:
        tags.append("too_long")
    if is_bullet_heavy(trimmed):
        tags.append("bullet_only")
    if contains_code_block(trimmed):
        tags.append("contains_code")
    if contains_ai_disclaimer(trimmed):
        tags.append("ai_disclaimer")
    if asks_question_back(trimmed):
        tags.append("asks_question_back")
    return tags


def quality_score(
    answer: str,
    *,
    question: str = "",
    context_lines: Iterable[str] | None = None,
    candidate_specific: bool = False,
) -> float:
    context_lines = list(context_lines or [])
    score = 0.45
    wc = word_count(answer)
    if contains_first_person(answer):
        score += 0.18
    if 45 <= wc <= 140:
        score += 0.15
    if not is_bullet_heavy(answer):
        score += 0.05
    if not contains_code_block(answer):
        score += 0.05
    if not contains_ai_disclaimer(answer):
        score += 0.04
    if not asks_question_back(answer):
        score += 0.03
    if question and lexical_overlap_ratio(question, answer) >= 0.05:
        score += 0.03
    if candidate_specific:
        score += min(0.07, groundedness_score(answer, context_lines) * 0.12)
    return round(max(0.0, min(1.0, score)), 4)


def classify_category(question: str, answer: str) -> str:
    lowered = f"{normalize_text(question)}\n{normalize_text(answer)}".lower()
    if any(token in lowered for token in BEHAVIORAL_KEYWORDS):
        return "behavioral_interview"
    if any(token in lowered for token in AI_KEYWORDS):
        if any(token in lowered for token in {"deployment", "gpu", "training", "serving", "latency", "inference"}):
            return "mlops_infra"
        return "nlp_and_llm"
    if any(token in lowered for token in SECURITY_KEYWORDS):
        return "security_appsec"
    if any(token in lowered for token in DB_KEYWORDS):
        return "database_engineering"
    if any(token in lowered for token in BACKEND_KEYWORDS):
        return "backend_api"
    if any(token in lowered for token in SYSTEM_KEYWORDS):
        return "system_design"
    return "coding_foundations"


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def locate_python() -> str:
    for candidate in ("py", "python"):
        resolved = shutil.which(candidate)
        if resolved:
            return candidate
    return "python"
