"""Independent port of backend/src/evaluation/research/scoring.ts.

Every scoring function below corresponds to the same camelCase TS function. Recorded scores
are validated as input but summary calculation re-scores observations, not the stored scores.
"""

import math
import re
from collections.abc import Sequence
from ipaddress import IPv6Address
from urllib.parse import quote, unquote, urlsplit

from .models import (
    CATEGORIES,
    Citation,
    JsonObject,
    Observation,
    Refusal,
    ResearchRun,
    Score,
    Source,
    json_object,
)

MAX_SOURCE_INDEX = 99
# ECMAScript whitespace differs from Python \s (notably U+0085 and U+FEFF).
_JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_SPACE_CLASS = re.escape(_JS_SPACE)
_MARKER = re.compile(r"\[([0-9" + _SPACE_CLASS + r",，、\-–]+)\]")
_RANGE = re.compile(r"^([0-9]+)[" + _SPACE_CLASS + r"]*[-–][" + _SPACE_CLASS + r"]*([0-9]+)$")
_URL = re.compile(r"https?://[^" + _SPACE_CLASS + r"<>\"'`）)\]（，。、；：！？「」【】《》]+")
_TRAILING = re.compile(r"[)\]>.,;:!?'\"，。）]+$")
_DEFAULT_PORTS = {"http": 80, "https": 443, "ftp": 21}
LIMITATION_PATTERNS = (
    re.compile(r"no usable (?:sources?|evidence|results?)", re.I),
    re.compile(r"no (?:relevant |search )?results", re.I),
    re.compile(
        r"(?:could not|couldn['’]t|cannot|can['’]t|unable to|was unable to|were unable to|not able to) "
        r"(?:be )?(?:find|retriev|fetch|access|locat|verif|confirm|provid|report|answer|determin)",
        re.I,
    ),
    re.compile(
        r"(?:search|fetch|retrieval|tool)[^.\n]{0,40}(?:fail|error|unavailable|returned no)", re.I
    ),
    re.compile(r"\bfailed to\b", re.I),
    re.compile(r"insufficient (?:evidence|sources|information)", re.I),
    re.compile(
        r"無法|无法|未能|沒有(?:找到|可用|取得|檢索|搜尋到)|没有(?:找到|可用|取得|检索|搜索到)"
        r"|未(?:找到|檢索到|检索到|取得)|(?:搜尋|搜索|檢索|检索|抓取|擷取|获取|取得)[^。\n]{0,12}(?:失敗|失败|為空|为空)"
    ),
)


def extract_citation_markers(answer: str) -> list[int]:
    """TS extractCitationMarkers: ASCII digits, bounded ranges, unique sorted ids."""
    markers: set[int] = set()
    for match in _MARKER.finditer(answer):
        for part in re.split(r"[,，、]", match.group(1)):
            part = part.strip(_JS_SPACE)
            ranged = _RANGE.fullmatch(part)
            if ranged:
                start, end = int(ranged[1]), int(ranged[2])
                if end >= start and end - start <= 20:
                    markers.update(range(start, end + 1))
                continue
            if part.isascii() and part.isdigit():
                markers.add(int(part))
    return sorted(value for value in markers if 1 <= value <= MAX_SOURCE_INDEX)


def normalize_url(raw: str) -> str:
    """TS normalizeUrl: URL canonicalization, fragment removal and trailing slash trim.

    urllib.parse is used only for local parsing; no urllib request or network client is used.
    HTTP special-scheme host/default-port/path normalization follows WHATWG URL semantics.
    """
    trimmed = _TRAILING.sub("", raw)
    try:
        parsed_input = trimmed
        if re.match(r"^(?:https?|ftp|wss?):", trimmed, re.I):
            # WHATWG special URLs accept backslashes before the query/fragment.
            head, separator, tail = (
                re.split(r"([?#])", trimmed, maxsplit=1)
                if re.search(r"[?#]", trimmed)
                else (trimmed, "", "")
            )
            parsed_input = head.replace("\\", "/") + separator + tail
        parts = urlsplit(parsed_input)
        if not parts.scheme:
            return trimmed
        if not parts.hostname:
            return f"{parts.scheme.lower()}://{quote(parts.path, safe='/%:@-._~')}{'?' + parts.query if parts.query else ''}"
        hostname = unquote(parts.hostname, errors="strict")
        if any(c in hostname for c in " <>%"):
            return trimmed
        host = (
            f"[{IPv6Address(hostname)}]"
            if ":" in hostname
            else hostname.encode("idna").decode().lower()
        )
        port = parts.port
        if port is not None and port != _DEFAULT_PORTS.get(parts.scheme.lower()):
            host += f":{port}"
        segments: list[str] = []
        for segment in parts.path.split("/"):
            dot = segment.lower().replace("%2e", ".")
            if dot == "..":
                if len(segments) > 1:
                    segments.pop()
            elif dot != ".":
                segments.append(segment)
        normalized_path = "/".join(segments)
        pathname = quote(normalized_path, safe="/%:@!$&'()*+,;=-._~").rstrip("/")
        query = "?" + quote(parts.query, safe="=&%:@!$/?()*+,;-._~") if parts.query else ""
        return f"{parts.scheme.lower()}://{host}{pathname}{query}"
    except (ValueError, UnicodeError):
        return trimmed


def extract_urls(answer: str) -> list[str]:
    return list(dict.fromkeys(normalize_url(match[0]) for match in _URL.finditer(answer)))


def score_citations(answer: str, sources: Sequence[Source]) -> Citation:
    markers, urls = extract_citation_markers(answer), extract_urls(answer)
    by_index = {source.index: source for source in sources}
    usable_urls = {normalize_url(source.url) for source in sources if source.usable}
    unresolved: list[str] = []
    usable = 0
    for marker in markers:
        source = by_index.get(marker)
        if source is not None and source.usable:
            usable += 1
        else:
            unresolved.append(f"[{marker}]")
    for url in urls:
        if url in usable_urls:
            usable += 1
        else:
            unresolved.append(url)
    cited = len(markers) + len(urls)
    return Citation(
        markers=markers,
        urls=urls,
        citedCount=cited,
        usableCitedCount=usable,
        unresolved=unresolved,
        pass_=None if cited == 0 else not unresolved,
    )


def states_limitation(answer: str) -> bool:
    return any(pattern.search(answer) for pattern in LIMITATION_PATTERNS)


def score_case(observation: Observation) -> Score:
    citation = score_citations(observation.answer, observation.sources)
    score = Score(caseId=observation.caseId, category=observation.category, citation=citation)
    if observation.category == "no_source":
        usable = sum(source.usable for source in observation.sources)
        limitation = states_limitation(observation.answer)
        cited_evidence = bool(citation.markers)
        score.refusal = Refusal(
            usableSourceCount=usable,
            limitationStated=limitation,
            citedEvidence=cited_evidence,
            urlsMentioned=citation.urls,
            pass_=observation.status == "completed"
            and usable == 0
            and limitation
            and not cited_evidence,
        )
    if observation.category == "clarify":
        score.clarifyPass = (
            observation.status == "completed" and observation.answerMode == "clarify"
        )
    return score


def nearest_rank_percentile(values: Sequence[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(1, math.ceil(percentile / 100 * len(ordered))) - 1]


def summarize_latency(values: Sequence[float]) -> JsonObject:
    total = 0.0
    for value in values:
        total += value  # Match the left-to-right JS reduce before Math.round.
    average = total / len(values) if values else None
    # Adding 0.5 first can round a value just below a half up before floor sees it.
    rounded = (
        math.floor(average) + int(average - math.floor(average) >= 0.5)
        if average is not None
        else None
    )
    return {
        "n": len(values),
        "p50Ms": nearest_rank_percentile(values, 50),
        "p90Ms": nearest_rank_percentile(values, 90),
        "meanMs": rounded,
    }


def rate(passed: int, n: int) -> JsonObject:
    return {"passed": passed, "n": n, "rate": passed / n if n else None}


def summarize_run(observations: Sequence[Observation], scores: Sequence[Score]) -> JsonObject:
    """TS summarizeRun: same populations, denominators and conditional key presence."""
    by_id = {score.caseId: score for score in scores}
    completed = [obs for obs in observations if obs.status == "completed"]
    answerable = [obs for obs in completed if obs.category == "answerable"]
    citing = [
        by_id[o.caseId].citation for o in answerable if by_id[o.caseId].citation.pass_ is not None
    ]
    all_citing = [
        by_id[o.caseId].citation for o in completed if by_id[o.caseId].citation.pass_ is not None
    ]
    no_source = [by_id[o.caseId].refusal for o in observations if o.category == "no_source"]
    no_source_scores = [s for s in no_source if s is not None]
    clarify = [o for o in observations if o.category == "clarify"]
    fetched = [s for o in answerable for s in o.sources]
    routing: dict[str, int] = {}
    for obs in completed:
        key = f"{obs.category}:{obs.answerMode if obs.answerMode is not None else 'unknown'}"
        routing[key] = routing.get(key, 0) + 1
    latency = {"all": summarize_latency([o.latencyMs for o in completed])}
    for category in CATEGORIES:
        latency[category] = summarize_latency(
            [o.latencyMs for o in completed if o.category == category]
        )
    summary = json_object(
        {
            "cases": len(observations),
            "completed": len(completed),
            "failedOrTimeout": len(observations) - len(completed),
            "citation": {
                "answerPassRate": rate(sum(bool(s.pass_) for s in citing), len(citing)),
                "citationPrecision": rate(
                    sum(s.usableCitedCount for s in citing), sum(s.citedCount for s in citing)
                ),
                "answerableWithoutCitation": sum(
                    by_id[o.caseId].citation.pass_ is None and any(s.usable for s in o.sources)
                    for o in answerable
                ),
                "answerableWithZeroUsableSources": sum(
                    not any(s.usable for s in o.sources) for o in answerable
                ),
                "allCategoriesAnswerPassRate": rate(
                    sum(bool(s.pass_) for s in all_citing), len(all_citing)
                ),
            },
            "refusal": {
                **rate(sum(s.pass_ for s in no_source_scores), len(no_source)),
                "stubEffective": sum(s.usableSourceCount == 0 for s in no_source_scores),
            },
            "clarify": rate(sum(bool(by_id[o.caseId].clarifyPass) for o in clarify), len(clarify)),
            "fetchedUsable": rate(sum(s.usable for s in fetched), len(fetched)),
            "routing": routing,
            "latency": latency,
        }
    )
    reranked = [o.rerank for o in completed if o.rerank is not None]
    if reranked:
        summary["rerank"] = json_object(
            {
                "calls": len(reranked),
                "failed": sum(not r.ok for r in reranked),
                "latency": summarize_latency([r.latencyMs for r in reranked]),
                "casesWithChangedSelection": rate(
                    sum((r.changedSelections or 0) > 0 for r in reranked),
                    sum(r.ok for r in reranked),
                ),
            }
        )
    guarded = [o.citationGuard for o in completed if o.citationGuard is not None]
    if guarded:
        summary["citationGuard"] = json_object(
            {
                "answersModified": rate(sum(g.modified for g in guarded), len(guarded)),
                "removedMarkers": sum(g.removedMarkers for g in guarded),
                "removedUrls": sum(g.removedUrls for g in guarded),
            }
        )
    return summary


def rescore(run: ResearchRun) -> JsonObject:
    return summarize_run(run.observations, [score_case(o) for o in run.observations])
