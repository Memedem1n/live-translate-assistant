#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
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
class GlobalPolicy:
    version: int = 1
    allow_domains: set[str] = field(default_factory=set)
    block_domains: set[str] = field(default_factory=set)
    exclude_url_patterns: list[str] = field(default_factory=list)
    search_results_per_query: int = 10
    max_per_domain: int = 20


@dataclass
class CategorySpec:
    name: str
    queries: list[str]
    seed_urls: list[str]
    weight: float = 1.0
    tier: str = "tier2"
    allow_domains: set[str] = field(default_factory=set)
    exclude_url_patterns: list[str] = field(default_factory=list)


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


def strip_html_simple(raw: str) -> str:
    cleaned = re.sub(r"(?is)<(script|style|noscript).*?>.*?</\1>", " ", raw)
    cleaned = re.sub(r"(?i)<br\s*/?>", "\n", cleaned)
    cleaned = re.sub(r"(?i)</p>|</li>|</h\d>|</section>|</article>", "\n", cleaned)
    cleaned = re.sub(r"(?s)<[^>]+>", " ", cleaned)
    cleaned = html.unescape(cleaned)
    cleaned = re.sub(r"[^\S\r\n]+", " ", cleaned)
    return normalize_text(cleaned)


def strip_html_bs4(raw: str) -> str:
    from bs4 import BeautifulSoup  # type: ignore

    soup = BeautifulSoup(raw, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = soup.get_text("\n")
    text = html.unescape(text)
    return normalize_text(text)


def strip_html_trafilatura(raw: str, url: str) -> str:
    import trafilatura  # type: ignore

    extracted = trafilatura.extract(
        raw,
        include_comments=False,
        include_tables=False,
        output_format="txt",
        url=url,
        favor_precision=True,
    )
    return normalize_text(extracted or "")


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
        title = normalize_text(strip_html_simple(match.group(1)))
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


def extract_links(raw_html: str, base_url: str, limit: int = 32) -> list[str]:
    parsed_base = urlparse(base_url)
    base_scheme = parsed_base.scheme
    base_host = normalize_host(parsed_base.netloc)
    links: list[str] = []
    seen: set[str] = set()

    hrefs = re.findall(r'(?is)href=["\']([^"\']+)["\']', raw_html)
    for href in hrefs:
        href = html.unescape(href).strip()
        if not href:
            continue
        if href.startswith("#"):
            continue

        if href.startswith("//"):
            candidate = f"{base_scheme}:{href}"
        elif href.startswith("http://") or href.startswith("https://"):
            candidate = href
        elif href.startswith("/"):
            candidate = f"{base_scheme}://{base_host}{href}"
        else:
            prefix = parsed_base.path or "/"
            if not prefix.endswith("/"):
                prefix = prefix[: prefix.rfind("/") + 1] if "/" in prefix else "/"
            candidate = f"{base_scheme}://{base_host}{prefix}{href}"

        canonical = canonicalize_url(candidate)
        if not canonical:
            continue
        if canonical in seen:
            continue
        seen.add(canonical)
        links.append(canonical)
        if len(links) >= max(1, limit):
            break

    return links


def normalize_host(host: str) -> str:
    lowered = host.strip().lower().rstrip(".")
    if lowered.startswith("www."):
        return lowered[4:]
    return lowered


def extract_host(url: str) -> str:
    try:
        return normalize_host(urlparse(url).netloc)
    except Exception:
        return ""


def as_domain_set(values: Any) -> set[str]:
    output: set[str] = set()
    if not isinstance(values, list):
        return output
    for item in values:
        domain = normalize_host(str(item or ""))
        if domain:
            output.add(domain)
    return output


def as_pattern_list(values: Any) -> list[str]:
    output: list[str] = []
    if not isinstance(values, list):
        return output
    for item in values:
        text = str(item or "").strip()
        if text:
            output.append(text)
    return output


def compile_patterns(patterns: list[str], warnings: list[str]) -> list[re.Pattern[str]]:
    output: list[re.Pattern[str]] = []
    for pattern in patterns:
        try:
            output.append(re.compile(pattern, re.IGNORECASE))
        except re.error as exc:
            warnings.append(f"invalid_pattern:{pattern}:{exc}")
    return output


def is_url_excluded(url: str, patterns: list[re.Pattern[str]]) -> bool:
    return any(pattern.search(url) for pattern in patterns)


def matches_domain(host: str, domains: set[str]) -> bool:
    if not domains:
        return True
    for domain in domains:
        if host == domain or host.endswith(f".{domain}"):
            return True
    return False


def canonicalize_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return ""
    host = normalize_host(parsed.netloc)
    if not host:
        return ""
    path = parsed.path or "/"
    path = re.sub(r"/+", "/", path)
    if path != "/":
        path = path.rstrip("/")
    return f"{parsed.scheme}://{host}{path}"


def load_global_policy(config: dict[str, Any]) -> GlobalPolicy:
    root = config.get("global")
    if not isinstance(root, dict):
        root = {}

    version = int(root.get("version") or 1)
    search_results_per_query = int(root.get("search_results_per_query") or 10)
    max_per_domain = int(root.get("max_per_domain") or 20)

    return GlobalPolicy(
        version=version,
        allow_domains=as_domain_set(root.get("allow_domains")),
        block_domains=as_domain_set(root.get("block_domains")),
        exclude_url_patterns=as_pattern_list(root.get("exclude_url_patterns")),
        search_results_per_query=max(1, search_results_per_query),
        max_per_domain=max(1, max_per_domain),
    )


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
        weight = float(item.get("weight") or 1.0)
        tier = str(item.get("tier") or "tier2").strip().lower() or "tier2"
        allow_domains = as_domain_set(item.get("allow_domains"))
        exclude_patterns = as_pattern_list(item.get("exclude_url_patterns"))
        output.append(
            CategorySpec(
                name=name,
                queries=queries,
                seed_urls=seed_urls,
                weight=max(0.05, weight),
                tier=tier,
                allow_domains=allow_domains,
                exclude_url_patterns=exclude_patterns,
            )
        )
    return output


def compute_category_quotas(
    categories: list[CategorySpec],
    max_docs: int,
    max_per_category: int,
    weighted: bool,
) -> dict[str, int]:
    if not categories or max_docs <= 0:
        return {}

    quotas: dict[str, int] = {}
    if weighted:
        total_weight = sum(max(0.05, category.weight) for category in categories)
        raw_targets: list[tuple[str, float]] = []
        for category in categories:
            raw_targets.append((category.name, max_docs * (category.weight / total_weight)))

        for name, raw in raw_targets:
            quotas[name] = min(max_per_category, max(0, int(math.floor(raw))))

        allocated = sum(quotas.values())
        remainders = sorted(raw_targets, key=lambda item: (item[1] - math.floor(item[1])), reverse=True)
        for name, _ in remainders:
            if allocated >= max_docs:
                break
            if quotas[name] >= max_per_category:
                continue
            quotas[name] += 1
            allocated += 1

        if allocated < max_docs:
            for category in sorted(categories, key=lambda item: item.weight, reverse=True):
                if allocated >= max_docs:
                    break
                if quotas[category.name] >= max_per_category:
                    continue
                quotas[category.name] += 1
                allocated += 1
    else:
        base = max(1, max_docs // len(categories))
        for category in categories:
            quotas[category.name] = min(max_per_category, base)
        allocated = sum(quotas.values())
        if allocated > max_docs:
            for category in sorted(categories, key=lambda item: quotas[item.name], reverse=True):
                if allocated <= max_docs:
                    break
                if quotas[category.name] <= 0:
                    continue
                quotas[category.name] -= 1
                allocated -= 1
        elif allocated < max_docs:
            for category in categories:
                if allocated >= max_docs:
                    break
                if quotas[category.name] >= max_per_category:
                    continue
                quotas[category.name] += 1
                allocated += 1

    return quotas


def extract_clean_text(
    raw_html: str,
    url: str,
    extractor_mode: str,
    warnings: list[str],
) -> tuple[str, str]:
    if extractor_mode == "simple":
        return strip_html_simple(raw_html), "simple"

    if extractor_mode == "trafilatura":
        try:
            text = strip_html_trafilatura(raw_html, url)
            if text:
                return text, "trafilatura"
            warnings.append(f"extract_empty:trafilatura:{url}")
        except Exception as exc:
            warnings.append(f"extract_failed:trafilatura:{url}:{exc}")
        return strip_html_simple(raw_html), "simple"

    # auto
    try:
        text = strip_html_trafilatura(raw_html, url)
        if text:
            return text, "trafilatura"
    except Exception:
        pass

    try:
        text = strip_html_bs4(raw_html)
        if text:
            return text, "bs4"
    except Exception:
        pass

    return strip_html_simple(raw_html), "simple"


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync interview-oriented web corpus.")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--max-docs", type=int, default=900)
    parser.add_argument("--max-per-category", type=int, default=90)
    parser.add_argument("--max-per-domain", type=int, default=0)
    parser.add_argument("--search-results-per-query", type=int, default=0)
    parser.add_argument("--crawl-depth", type=int, default=1)
    parser.add_argument("--crawl-links-per-page", type=int, default=18)
    parser.add_argument("--min-quality", type=float, default=0.30)
    parser.add_argument("--dedupe-jaccard", type=float, default=0.84)
    parser.add_argument("--min-text-chars", type=int, default=1200)
    parser.add_argument(
        "--category-weighted-quota",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Distribute per-category quotas with weight values from config.",
    )
    parser.add_argument("--tier1-only", action="store_true", help="Allow only domains from global allow_domains.")
    parser.add_argument("--extractor-mode", choices=["auto", "simple", "trafilatura"], default="auto")
    parser.add_argument("--config-version", type=int, default=0)
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

    global_policy = load_global_policy(config)
    categories = list(iter_categories(config))

    if args.config_version > 0 and global_policy.version != args.config_version:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"Config version mismatch: expected={args.config_version}, found={global_policy.version}",
                },
                ensure_ascii=False,
            )
        )
        return 2

    if not categories:
        print(json.dumps({"ok": False, "error": "Config categories bos."}, ensure_ascii=False))
        return 2

    max_docs = max(1, int(args.max_docs))
    max_per_category = max(1, int(args.max_per_category))
    max_per_domain = max(1, int(args.max_per_domain or global_policy.max_per_domain))
    search_results_per_query = max(
        1,
        int(args.search_results_per_query or global_policy.search_results_per_query),
    )
    crawl_depth = max(0, int(args.crawl_depth))
    crawl_links_per_page = max(0, int(args.crawl_links_per_page))
    min_quality = max(0.0, min(1.0, float(args.min_quality)))
    dedupe_jaccard = max(0.5, min(0.98, float(args.dedupe_jaccard)))
    min_text_chars = max(400, int(args.min_text_chars))
    include_search = not args.no_search

    category_quotas = compute_category_quotas(
        categories=categories,
        max_docs=max_docs,
        max_per_category=max_per_category,
        weighted=bool(args.category_weighted_quota),
    )

    seen_urls: set[str] = set()
    seen_fingerprints: set[str] = set()
    seen_token_sets: list[set[str]] = []
    documents: list[dict[str, Any]] = []

    category_counter: Counter[str] = Counter()
    origin_counter: Counter[str] = Counter()
    domain_counter: Counter[str] = Counter()
    extractor_counter: Counter[str] = Counter()
    rejected_counter: Counter[str] = Counter()
    crawl_counter: Counter[str] = Counter()

    for category in categories:
        if len(documents) >= max_docs:
            break

        category_quota = max(0, int(category_quotas.get(category.name, max_per_category)))
        if category_quota <= 0:
            continue

        candidate_urls: list[tuple[str, str, int]] = []
        candidate_urls.extend((url, "seed", 0) for url in category.seed_urls)
        candidate_seen: set[str] = set()
        if include_search:
            for query in category.queries:
                try:
                    for url in search_duckduckgo(query, limit=search_results_per_query):
                        candidate_urls.append((url, "search", 0))
                except Exception as exc:
                    warnings.append(f"search_failed:{category.name}:{query}:{exc}")

        combined_patterns = global_policy.exclude_url_patterns + category.exclude_url_patterns
        exclude_patterns = compile_patterns(combined_patterns, warnings)

        allowed_domains = set(global_policy.allow_domains)
        if category.allow_domains:
            allowed_domains.update(category.allow_domains)

        per_category_count = 0
        queue_index = 0
        while queue_index < len(candidate_urls):
            candidate_url, origin, depth = candidate_urls[queue_index]
            queue_index += 1
            if len(documents) >= max_docs or per_category_count >= category_quota:
                break

            canonical_url = canonicalize_url(candidate_url)
            if not canonical_url:
                rejected_counter["invalid_scheme_or_url"] += 1
                continue
            if canonical_url in seen_urls:
                rejected_counter["duplicate_url"] += 1
                continue

            host = extract_host(canonical_url)
            if not host:
                rejected_counter["missing_host"] += 1
                continue

            if matches_domain(host, global_policy.block_domains):
                rejected_counter["blocked_domain"] += 1
                continue

            if args.tier1_only and global_policy.allow_domains and not matches_domain(host, global_policy.allow_domains):
                rejected_counter["tier1_only_filtered"] += 1
                continue

            if allowed_domains and not matches_domain(host, allowed_domains):
                rejected_counter["allow_domain_filtered"] += 1
                continue

            if is_url_excluded(canonical_url, exclude_patterns):
                rejected_counter["excluded_pattern"] += 1
                continue

            if domain_counter[host] >= max_per_domain:
                rejected_counter["per_domain_cap"] += 1
                continue

            try:
                html_payload = fetch_url(canonical_url, timeout=15)
            except Exception as exc:
                warnings.append(f"fetch_failed:{canonical_url}:{exc}")
                rejected_counter["fetch_failed"] += 1
                continue

            if crawl_links_per_page > 0 and depth < crawl_depth:
                for crawled_url in extract_links(html_payload, canonical_url, limit=crawl_links_per_page):
                    if crawled_url in candidate_seen:
                        continue
                    candidate_seen.add(crawled_url)
                    candidate_urls.append((crawled_url, "crawl", depth + 1))
                    crawl_counter[category.name] += 1

            title = extract_title(html_payload, canonical_url)
            text, extract_method = extract_clean_text(
                raw_html=html_payload,
                url=canonical_url,
                extractor_mode=args.extractor_mode,
                warnings=warnings,
            )
            if len(text) < min_text_chars:
                rejected_counter["min_text_chars"] += 1
                continue
            if looks_like_noise(text):
                rejected_counter["noise"] += 1
                continue

            text_tokens = token_set(text)
            near_duplicate = False
            for previous in seen_token_sets[-240:]:
                if jaccard(previous, text_tokens) >= dedupe_jaccard:
                    near_duplicate = True
                    break
            if near_duplicate:
                rejected_counter["near_duplicate"] += 1
                continue

            fingerprint = hashlib.sha1(" ".join(sorted(text_tokens)).encode("utf-8")).hexdigest()
            if fingerprint in seen_fingerprints:
                rejected_counter["fingerprint_duplicate"] += 1
                continue

            language = detect_language(text)
            quality_score = compute_quality(text, title)
            if quality_score < min_quality:
                rejected_counter["quality_threshold"] += 1
                continue

            doc_id = hashlib.md5(f"{canonical_url}|{title}".encode("utf-8")).hexdigest()[:16]
            documents.append(
                {
                    "id": doc_id,
                    "url": canonical_url,
                    "title": title,
                    "category": category.name,
                    "origin": origin,
                    "tier": category.tier,
                    "source_domain": host,
                    "language": language,
                    "quality_score": round(quality_score, 4),
                    "extract_method": extract_method,
                    "text_hash": fingerprint[:16],
                    "fetched_at": int(time.time() * 1000),
                    "text": text[:22000],
                }
            )

            seen_urls.add(canonical_url)
            seen_fingerprints.add(fingerprint)
            seen_token_sets.append(text_tokens)
            per_category_count += 1

            category_counter[category.name] += 1
            origin_counter[origin] += 1
            domain_counter[host] += 1
            extractor_counter[extract_method] += 1

    ensure_parent(output_path)
    with output_path.open("w", encoding="utf-8") as stream:
        for item in documents:
            stream.write(json.dumps(item, ensure_ascii=False) + "\n")

    payload = {
        "ok": True,
        "config": str(config_path),
        "config_version": global_policy.version,
        "output": str(output_path),
        "documents": len(documents),
        "elapsed_ms": int((time.time() - started_at) * 1000),
        "min_quality": min_quality,
        "dedupe_jaccard": dedupe_jaccard,
        "max_docs": max_docs,
        "max_per_category": max_per_category,
        "max_per_domain": max_per_domain,
        "search_results_per_query": search_results_per_query,
        "crawl_depth": crawl_depth,
        "crawl_links_per_page": crawl_links_per_page,
        "extractor_mode": args.extractor_mode,
        "category_weighted_quota": bool(args.category_weighted_quota),
        "category_quota": category_quotas,
        "category_counter": dict(category_counter),
        "origin_counter": dict(origin_counter),
        "domain_counter": dict(domain_counter.most_common(120)),
        "extractor_counter": dict(extractor_counter),
        "crawl_counter": dict(crawl_counter),
        "rejected_counter": dict(rejected_counter),
        "warnings": warnings[:400],
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
