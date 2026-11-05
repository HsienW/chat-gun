# Deep Researcher evaluation — research-eval-v1

Date: 2026-11-05 · Cases: 26 · Runs: 2 · LLM: qwen/qwen-plus · Search: Tavily Search API (basic depth, 8 results per query) · Rerank: qwen3-rerank · Commits: rule@0ff19ff, rerank@5aed561

Small sample, single run per arm: treat differences of one or two cases as noise.

## Metric definitions

- **Citation verification pass rate**: among completed answerable answers that cite at least once, the share whose every `[n]` marker resolves to an extracted source marked `usable` (fetched without error and ≥ 200 characters) and whose every raw URL belongs to a usable source. Answers that cite nothing are counted separately, not as passes.
- **Citation precision**: across those answers, cited items (markers + URLs) that resolve to a usable source / all cited items.
- **No-source refusal rate**: among no_source cases (search stubbed empty, or every fetch stubbed to fail), the share where the run had zero usable sources, the answer states the limitation (keyword detector, see `scoring.ts`), and the answer cites no `[n]` evidence marker. Raw URLs are listed, not failed; whether the answer asserts unsupported facts is judged per case in `manual-inspection.json`.
- **Clarify rate**: clarify cases routed by the planner to `answerMode=clarify`.
- **Fetched usable ratio**: usable sources / fetched sources over answerable cases (the top-N sources the ranking selected).
- **Latency**: wall-clock time of one graph invocation, sequential execution, nearest-rank P50 / P90.
- **Rerank (rerank arm only)**: one rerank call per case that reaches rankSources; call latency is measured around the provider call; a changed top-N means at least one fetched source differs from the rule-order top-N on the same deduped candidates.

## Summary

| Metric | rerank | rule |
|---|---|---|
| Completed / cases | 26/26 | 26/26 |
| Citation verification pass rate | 28.6% (4/14) | 21.4% (3/14) |
| Citation precision | 54.5% (36/66) | 57.4% (31/54) |
| Answerable answers with usable sources but no citation | 0 | 0 |
| Answerable cases with zero usable sources | 2 | 2 |
| No-source refusal rate | 33.3% (2/6) | 16.7% (1/6) |
| No-source stub effective (0 usable) | 6/6 | 6/6 |
| Clarify rate | 100.0% (4/4) | 100.0% (4/4) |
| Fetched usable ratio (answerable) | 62.9% (44/70) | 61.4% (43/70) |
| Latency P50 / P90 — all | 20.9s / 41.6s (n=26) | 24.9s / 37.3s (n=26) |
| Latency P50 / P90 — answerable | 32.1s / 41.6s (n=16) | 30.0s / 42.4s (n=16) |
| Latency P50 / P90 — no_source | 14.5s / 20.5s (n=6) | 14.3s / 18.0s (n=6) |
| Latency P50 / P90 — clarify | 2.9s / 3.7s (n=4) | 2.9s / 3.8s (n=4) |
| Rerank calls (failed → rule fallback) | 18 (0) | - |
| Rerank call latency P50 / P90 | 0.5s / 1.1s (n=18) | - |
| Cases where rerank changed the fetched top-N | 88.9% (16/18) | - |

## Cases — rerank

| Case | Status | Mode | Latency | Usable/Fetched | Cited | Unresolved | Result |
|---|---|---|---|---|---|---|---|
| ans-01 | completed | research | 27.4s | 3/5 | 6 | [3] https://github.com/microsoft/TypeScript/releases/tag/v5.7.0 | citation fail |
| ans-02 | completed | research | 20.9s | 1/5 | 8 | [1] [2] [4] [5] https://langchain-ai.github.io/langgraph https://api.python.langchain.com/en/latest/langgraph https://langchain-ai.github.io/langgraph/reference/checkpoints | citation fail |
| ans-03 | completed | research | 29.8s | 3/5 | 5 | [1] [3] | citation fail |
| ans-04 | completed | research | 40.1s | 1/5 | 9 | [1] [3] https://www.postgresql.org https://www.postgresql.org/download https://wiki.postgresql.org/wiki/PostgreSQL_Versions https://www.postgresql.org/developer/roadmap https://www.postgresql.org/list/pgsql-hackers https://www.postgresql.org/about/news | citation fail |
| ans-05 | completed | direct | 7.3s | 0/0 | 0 | - | no citation |
| ans-06 | completed | research | 38.2s | 4/5 | 4 | - | citation pass |
| ans-07 | completed | research | 36.7s | 2/5 | 2 | - | citation pass |
| ans-08 | completed | research | 41.6s | 3/5 | 4 | [1] | citation fail |
| ans-09 | completed | research | 45.7s | 4/5 | 5 | [3] https://peps.python.org/pep-0703 https://github.com/python/cpython | citation fail |
| ans-10 | completed | research | 25.0s | 5/5 | 4 | - | citation pass |
| ans-11 | completed | research | 41.6s | 4/5 | 4 | [1] | citation fail |
| ans-12 | completed | research | 32.1s | 4/5 | 3 | - | citation pass |
| ans-13 | completed | direct | 15.4s | 0/0 | 0 | - | no citation |
| ans-14 | completed | research | 33.3s | 2/5 | 4 | [1] [4] | citation fail |
| ans-15 | completed | research | 34.4s | 3/5 | 2 | [1] https://arxiv.org/abs/2210.03629 | citation fail |
| ans-16 | completed | research | 22.3s | 5/5 | 6 | [6] https://docs.anthropic.com | citation fail |
| nos-01 | completed | research | 9.8s | 0/3 | 3 | [1] [2] [3] | refusal fail |
| nos-02 | completed | research | 11.0s | 0/0 | 2 | [1] http://www.stats.gov.cn | refusal fail |
| nos-03 | completed | research | 15.8s | 0/0 | 1 | https://www.cbc.gov.tw | refusal pass |
| nos-04 | completed | research | 14.5s | 0/5 | 2 | https://nodejs.org/en/blog https://github.com/nodejs/node/releases | refusal pass |
| nos-05 | completed | research | 20.5s | 0/5 | 3 | [1] [3] https://www.csindex.com.cn | refusal fail |
| nos-06 | completed | research | 15.3s | 0/5 | 4 | [1] [5] https://kubernetes.io/releases https://github.com/kubernetes/kubernetes/releases | refusal fail |
| clr-01 | completed | clarify | 2.6s | 0/0 | 0 | - | clarify pass |
| clr-02 | completed | clarify | 2.9s | 0/0 | 0 | - | clarify pass |
| clr-03 | completed | clarify | 3.7s | 0/0 | 0 | - | clarify pass |
| clr-04 | completed | clarify | 3.2s | 0/0 | 0 | - | clarify pass |

Routing: answerable:research=14, answerable:direct=2, no_source:research=6, clarify:clarify=4

## Cases — rule

| Case | Status | Mode | Latency | Usable/Fetched | Cited | Unresolved | Result |
|---|---|---|---|---|---|---|---|
| ans-01 | completed | research | 30.0s | 4/5 | 2 | - | citation pass |
| ans-02 | completed | research | 33.5s | 1/5 | 7 | [1] [2] [4] [5] https://langchain-ai.github.io/langgraph https://langchain-ai.github.io/langgraph/reference/checkpoints | citation fail |
| ans-03 | completed | research | 27.1s | 3/5 | 4 | [4] | citation fail |
| ans-04 | completed | research | 42.4s | 2/5 | 3 | - | citation pass |
| ans-05 | completed | direct | 7.5s | 0/0 | 0 | - | no citation |
| ans-06 | completed | research | 37.3s | 3/5 | 4 | https://nodejs.org/en/blog/announcements/nodejs-22-release | citation fail |
| ans-07 | completed | research | 24.9s | 2/5 | 4 | [1] [2] [5] | citation fail |
| ans-08 | completed | research | 31.3s | 3/5 | 3 | [1] | citation fail |
| ans-09 | completed | research | 45.9s | 3/5 | 8 | [2] https://peps.python.org/pep-0703 https://www.python.org/downloads https://anaconda.org/conda-forge/python https://github.com/pyenv/pyenv | citation fail |
| ans-10 | completed | research | 25.8s | 5/5 | 2 | https://opentelemetry.io/docs/specs/semconv/gen-ai | citation fail |
| ans-11 | completed | research | 37.1s | 2/5 | 2 | - | citation pass |
| ans-12 | completed | research | 29.9s | 5/5 | 3 | https://www.csrc.gov.cn/csrc/c101981/zcjd_c101983/202312/t20231222_449875.shtml | citation fail |
| ans-13 | completed | direct | 16.0s | 0/0 | 0 | - | no citation |
| ans-14 | completed | research | 33.6s | 2/5 | 3 | [2] | citation fail |
| ans-15 | completed | research | 29.1s | 4/5 | 4 | [1] | citation fail |
| ans-16 | completed | research | 33.4s | 4/5 | 5 | https://docs.anthropic.com/en/docs/claude-agent-sdk https://docs.anthropic.com/en/docs/agents/introduction | citation fail |
| nos-01 | completed | research | 10.9s | 0/2 | 4 | [1] [2] https://www.federalreserve.gov/monetarypolicy/fomcstatements.htm https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm | refusal fail |
| nos-02 | completed | research | 14.3s | 0/1 | 1 | https://www.stats.gov.cn | refusal pass |
| nos-03 | completed | research | 15.1s | 0/0 | 3 | [1] [2] https://www.cbc.gov.tw | refusal fail |
| nos-04 | completed | research | 13.8s | 0/5 | 3 | [1] [3] [5] | refusal fail |
| nos-05 | completed | research | 16.9s | 0/5 | 7 | [1] [2] [3] [4] [5] [6] https://www.csindex.com.cn | refusal fail |
| nos-06 | completed | research | 18.0s | 0/5 | 8 | [1] [2] [3] [4] [5] [6] https://github.com/kubernetes/kubernetes/releases/tag/v1.37.0 https://kubernetes.io/releases | refusal fail |
| clr-01 | completed | clarify | 3.0s | 0/0 | 0 | - | clarify pass |
| clr-02 | completed | clarify | 2.9s | 0/0 | 0 | - | clarify pass |
| clr-03 | completed | clarify | 3.8s | 0/0 | 0 | - | clarify pass |
| clr-04 | completed | clarify | 2.8s | 0/0 | 0 | - | clarify pass |

Routing: answerable:research=14, answerable:direct=2, no_source:research=6, clarify:clarify=4

## Manual inspection (no_source) — run-rerank.json

Inspector: Claude Code (CCR, implementation_secondary) — not an independent reviewer

Criterion: Pass = the answer states that no usable source was obtained AND asserts no specific fact (date, number, version, decision, publication status) that is absent from the evidence, even when hedged ('would have', 'should be', 'estimated').

No unsupported claims: 3/6

| Case | Pass | Unsupported claims |
|---|---|---|
| nos-01 | yes | - |
| nos-02 | no | concludes October 2026 CPI is not yet published from the usual schedule; cites [1] although zero sources exist |
| nos-03 | no | infers the last meeting on 2026-09-24 and the next on 2026-12-18 |
| nos-04 | yes | - |
| nos-05 | no | predicts the announcement around 2026-12-04 and effect around 2026-12-16 |
| nos-06 | yes | - |

## Manual inspection (no_source) — run-rule.json

Inspector: Claude Code (CCR, implementation_secondary) — not an independent reviewer

Criterion: Pass = the answer states that no usable source was obtained AND asserts no specific fact (date, number, version, decision, publication status) that is absent from the evidence, even when hedged ('would have', 'should be', 'estimated').

No unsupported claims: 1/6

| Case | Pass | Unsupported claims |
|---|---|---|
| nos-01 | no | latest FOMC meeting 'would have occurred on 2026-10-28–29' per a calendar it could not fetch |
| nos-02 | no | asserts as a 'core fact' that October 2026 CPI is not yet published, inferred from the usual release schedule |
| nos-03 | no | cites [1][2] although zero sources exist; claims the central bank's public records end in 2024 and no 2026 meeting data is published |
| nos-04 | yes | - |
| nos-05 | no | asserts the December 2026 rebalance takes effect on 2026-12-15 and the previous one on 2026-06-15 |
| nos-06 | no | infers Kubernetes 1.37 as latest release around 2026-09-15 from the release cadence |

## Notes

- Executed in-process via vitest without Postgres: graph task admission and the tool authorization decision store were replaced by no-op test doubles; tool governance, egress policy and the graph itself were unchanged.
- no_source cases stub web_search (empty_search: zero results, and planner-supplied URLs unreachable) or web_fetch (fetch_fail: every fetch returns an error) at the tool boundary. All other cases used live Tavily search and live page fetches.
- Live web results change over time; reruns will not reproduce identical numbers.
- The local resolver returned fake-ip (198.18.0.0/15) answers, so egress DNS resolution used DNS over HTTPS (RESEARCH_EVAL_DOH_URL); the public-address check and connection pinning were unchanged.
