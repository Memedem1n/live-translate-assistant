#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, quote_plus, unquote, urlparse
from urllib.request import Request, urlopen


DEFAULT_CONFIG = "configs/web_corpus_sources.yaml"
DEFAULT_OUTPUT = "artifacts/corpus/web_corpus.jsonl"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
TECH_HINTS = {
    "system",
    "design",
    "latency",
    "throughput",
    "cache",
    "distributed",
    "database",
    "kubernetes",
    "docker",
    "microservice",
    "architecture",
    "interview",
    "algorithm",
    "complexity",
    "nlp",
    "llm",
    "transformer",
    "embedding",
    "vector",
    "retrieval",
    "rag",
    "prompt",
    "python",
    "typescript",
    "backend",
    "observability",
    "security",
    "mlops",
}
EN_STOPWORDS = {"the", "and", "is", "are", "with", "for", "that", "this", "you", "your", "how"}
TR_STOPWORDS = {"ve", "ile", "icin", "bu", "bir", "olarak", "nasil", "neden", "hangi", "kadar"}
NOISE_MARKERS = {
    "cookie",
    "subscribe",
    "sign in",
    "log in",
    "privacy policy",
    "accept all",
    "terms of service",
    "advertisement",
    "javascript is disabled",
}


@dataclass
class CategorySpec:
    name: str
    queries: list[str]
    seed_urls: list[str]


def read_text(path: Path) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1254", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="ignore")


def load_config(path: Path) -> dict[str, Any]:
    raw = read_text(path).strip()
    if not raw:
        raise RuntimeError("Config bos.")

    try:
        loaded = json.loads(raw)
        if isinstance(loaded, dict):
            return loaded
    except json.JSONDecodeError:
        pass

    try:
        import yaml  # type: ignore

        loaded = yaml.safe_load(raw)
        if isinstance(loaded, dict):
            return loaded
    except Exception as exc:
        raise RuntimeError("Config parse edilemedi. JSON ya da PyYAML ile YAML gerekli.") from exc

    raise RuntimeError("Config beklenen formatta degil.")


def normalize_text(value: str) -> str:
    value = value.replace("\r\n", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def strip_html(raw: str) -> str:
    cleaned = re.sub(r"(?is)<(script|style|noscript).*?>.*?</\1>", " ", raw)
    cleaned = re.sub(r"(?i)<br\s*/?>", "\n", cleaned)
    cleaned = re.sub(r"(?i)</p>|</li>|</h\d>|</section>|</article>", "\n", cleaned)
    cleaned = re.sub(r"(?s)<[^>]+>", " ", cleaned)
    cleaned = html.unescape(cleaned)
    cleaned = re.sub(r"[^\S\r\n]+", " ", cleaned)
    return normalize_text(cleaned)


def detect_language(text: str) -> str:
    lowered = text.lower()
    en = sum(lowered.count(word) for word in EN_STOPWORDS)
    tr = sum(lowered.count(word) for word in TR_STOPWORDS)
    if re.search(r"[\u011f\u00fc\u015f\u00f6\u00e7\u0131\u0130\u011e\u00dc\u015e\u00d6\u00c7]", text):
        tr += 2
    return "tr" if tr > en else "en"


def extract_title(raw_html: str, fallback_url: str) -> str:
    match = re.search(r"(?is)<title[^>]*>(.*?)</title>", raw_html)
    if match:
        title = normalize_text(strip_html(match.group(1)))
        if title:
            return title[:180]
    host = urlparse(fallback_url).netloc or "web"
    return host


def looks_like_noise(text: str) -> bool:
    lowered = text.lower()
    marker_hits = sum(1 for marker in NOISE_MARKERS if marker in lowered)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return True

    short_lines = sum(1 for line in lines if len(line) < 40)
    short_ratio = short_lines / max(1, len(lines))
    unique_lines = len(set(lines)) / max(1, len(lines))

    if marker_hits >= 4 and short_ratio >= 0.6:
        return True
    if len(text) < 2200 and short_ratio >= 0.72 and unique_lines <= 0.42:
        return True
    return False


def compute_quality(text: str, title: str) -> float:
    words = re.findall(r"[A-Za-z0-9_\-\u00C0-\u024F]+", text.lower())
    word_count = len(words)
    if word_count == 0:
        return 0.0

    unique_ratio = len(set(words)) / max(1, word_count)
    tech_hits = sum(1 for word in words if word in TECH_HINTS)
    qa_hits = len(
        re.findall(
            r"\b(what|how|why|when|difference|explain|design|interview|tradeoff|latency)\b",
            text.lower(),
        )
    )
    sentence_like = len(re.findall(r"[^.!?]+[.!?]+", text))
    sentence_density = min(sentence_like / 40.0, 1.0)
    punctuation_penalty = 0.0
    if text.count("{") > 14 or text.count("}") > 14:
        punctuation_penalty += 0.05

    score = (
        min(word_count / 1600.0, 1.0) * 0.3
        + min(unique_ratio, 1.0) * 0.2
        + min(tech_hits / 22.0, 1.0) * 0.3
        + min(qa_hits / 12.0, 1.0) * 0.1
        + sentence_density * 0.1
        - punctuation_penalty
    )
    if "interview" in title.lower():
        score += 0.03
    return float(max(0.0, min(1.0, score)))


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a.intersection(b)) / max(1, len(a.union(b)))


def token_set(text: str, max_tokens: int = 260) -> set[str]:
    tokens = re.findall(r"[A-Za-z0-9_\-\u00C0-\u024F]+", text.lower())
    return set(tokens[:max_tokens])


def decode_duckduckgo_href(href: str) -> str:
    href = html.unescape(href)
    if href.startswith("//"):
        return f"https:{href}"
    if href.startswith("http://") or href.startswith("https://"):
        return href
    parsed = urlparse(href)
    if parsed.query:
        query = parse_qs(parsed.query)
        uddg = query.get("uddg")
        if uddg and uddg[0]:
            return unquote(uddg[0])
    return href


def fetch_url(url: str, timeout: int = 12) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"})
    with urlopen(request, timeout=timeout) as response:
        content_type = response.headers.get("Content-Type", "")
        payload = response.read()
        charset = "utf-8"
        match = re.search(r"charset=([^;]+)", content_type, re.IGNORECASE)
        if match:
            charset = match.group(1).strip()
        try:
            return payload.decode(charset, errors="ignore")
        except LookupError:
            return payload.decode("utf-8", errors="ignore")


def search_duckduckgo(query: str, limit: int) -> list[str]:
    url = f"https://duckduckgo.com/html/?q={quote_plus(query)}"
    html_text = fetch_url(url, timeout=10)
    links: list[str] = []
    for raw_href in re.findall(r'(?is)class="result__a"[^>]+href="([^"]+)"', html_text):
        decoded = decode_duckduckgo_href(raw_href)
        if decoded.startswith("http://") or decoded.startswith("https://"):
            links.append(decoded)
        if len(links) >= limit:
            break
    return links


def iter_categories(config: dict[str, Any]) -> Iterable[CategorySpec]:
    categories = config.get("categories") or []
    if not isinstance(categories, list):
        return []
    output: list[CategorySpec] = []
    for item in categories:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip() or "general"
        queries = [str(q).strip() for q in (item.get("queries") or []) if str(q).strip()]
        seed_urls = [str(u).strip() for u in (item.get("seed_urls") or []) if str(u).strip()]
        output.append(CategorySpec(name=name, queries=queries, seed_urls=seed_urls))
    return output


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync interview-oriented web corpus.")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--max-docs", type=int, default=900)
    parser.add_argument("--max-per-category", type=int, default=90)
    parser.add_argument("--min-quality", type=float, default=0.30)
    parser.add_argument("--dedupe-jaccard", type=float, default=0.84)
    parser.add_argument("--min-text-chars", type=int, default=1200)
    parser.add_argument("--no-search", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    started_at = time.time()
    warnings: list[str] = []
    config_path = Path(args.config).resolve()
    output_path = Path(args.output).resolve()

    if not config_path.exists():
        payload = {"ok": False, "error": f"Config bulunamadi: {config_path}"}
        print(json.dumps(payload, ensure_ascii=False))
        return 2

    try:
        config = load_config(config_path)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"Config okunamadi: {exc}"}, ensure_ascii=False))
        return 2

    max_docs = max(1, int(args.max_docs))
    max_per_category = max(1, int(args.max_per_category))
    min_quality = max(0.0, min(1.0, float(args.min_quality)))
    dedupe_jaccard = max(0.5, min(0.98, float(args.dedupe_jaccard)))
    min_text_chars = max(400, int(args.min_text_chars))
    include_search = not args.no_search

    seen_urls: set[str] = set()
    seen_fingerprints: set[str] = set()
    seen_token_sets: list[set[str]] = []
    documents: list[dict[str, Any]] = []

    for category in iter_categories(config):
        if len(documents) >= max_docs:
            break

        candidate_urls: list[tuple[str, str]] = []
        candidate_urls.extend((url, "seed") for url in category.seed_urls)
        if include_search:
            for query in category.queries:
                try:
                    for url in search_duckduckgo(query, limit=10):
                        candidate_urls.append((url, "search"))
                except Exception as exc:
                    warnings.append(f"search_failed:{category.name}:{query}:{exc}")

        per_category_count = 0
        for candidate_url, origin in candidate_urls:
            if len(documents) >= max_docs or per_category_count >= max_per_category:
                break

            parsed = urlparse(candidate_url)
            if parsed.scheme not in {"http", "https"}:
                continue
            canonical_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
            if canonical_url in seen_urls:
                continue
            seen_urls.add(canonical_url)

            try:
                html_payload = fetch_url(candidate_url, timeout=15)
            except Exception as exc:
                warnings.append(f"fetch_failed:{candidate_url}:{exc}")
                continue

            title = extract_title(html_payload, candidate_url)
            text = strip_html(html_payload)
            if len(text) < min_text_chars:
                continue
            if looks_like_noise(text):
                continue

            text_tokens = token_set(text)
            near_duplicate = False
            for previous in seen_token_sets[-240:]:
                if jaccard(previous, text_tokens) >= dedupe_jaccard:
                    near_duplicate = True
                    break
            if near_duplicate:
                continue

            fingerprint = hashlib.sha1(" ".join(sorted(text_tokens)).encode("utf-8")).hexdigest()
            if fingerprint in seen_fingerprints:
                continue
            seen_fingerprints.add(fingerprint)
            seen_token_sets.append(text_tokens)

            language = detect_language(text)
            quality_score = compute_quality(text, title)
            if quality_score < min_quality:
                continue

            doc_id = hashlib.md5(f"{candidate_url}|{title}".encode("utf-8")).hexdigest()[:16]
            documents.append(
                {
                    "id": doc_id,
                    "url": candidate_url,
                    "title": title,
                    "category": category.name,
                    "origin": origin,
                    "language": language,
                    "quality_score": round(quality_score, 4),
                    "fetched_at": int(time.time() * 1000),
                    "text": text[:22000],
                }
            )
            per_category_count += 1

    ensure_parent(output_path)
    with output_path.open("w", encoding="utf-8") as stream:
        for item in documents:
            stream.write(json.dumps(item, ensure_ascii=False) + "\n")

    payload = {
        "ok": True,
        "config": str(config_path),
        "output": str(output_path),
        "documents": len(documents),
        "elapsed_ms": int((time.time() - started_at) * 1000),
        "min_quality": min_quality,
        "dedupe_jaccard": dedupe_jaccard,
        "warnings": warnings[:300],
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

