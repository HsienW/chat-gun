# research-eval-v1 · 2026-11-05 · analysis

Hand-written interpretation of `report.md` (generated). All numbers come from `run-rule.json`,
`run-rerank.json` and `run-guard.json`; 26 cases, one run per arm, qwen-plus planner and
synthesis, Tavily search, qwen3-rerank for the rerank arm. Commits: rule@0ff19ff, rerank@5aed561,
guard@ec8c1a3. Each arm turns on only its own feature (`DEEP_RESEARCH_SOURCE_RERANK`,
`DEEP_RESEARCH_CITATION_GUARD`); the rule arm has both off.

## Baseline (rule ranking)

| Metric | Value |
|---|---|
| Citation verification pass rate | 3/14 (21.4%) |
| Citation precision | 31/54 (57.4%) |
| — `[n]` markers resolving to a usable source | 25/37 |
| — raw URLs resolving to a usable source | 6/17 |
| No-source: states the failure | 6/6 |
| No-source: automatic refusal pass (no `[n]` evidence marker) | 1/6 |
| No-source: manual pass (no unsupported specific claim) | 1/6 |
| Clarify routed to clarify | 4/4 |
| Fetched usable ratio | 43/70 (61.4%) |
| Latency P50 / P90, all 26 | 24.9s / 37.3s |
| Latency P50 / P90, answerable 16 | 30.0s / 42.4s |

Two answerable questions (ans-05, ans-13) were answered by the planner in `direct` mode without
search, so the citation metrics cover 14 answers.

What fails is synthesis, not retrieval: every citing answer had at least one usable source, yet 11
of 14 cited something unusable. Failures split into `[n]` markers that point at sources whose fetch
failed or returned under 200 characters (7 answers), and URLs the model wrote that were never
fetched or were not usable (6 answers; 2 answers have both). On no-source cases the graph never
fabricated an answer outright — all 6 said no usable source was obtained — but 5 of 6 still added
specific dates, versions or publication-status claims from prior knowledge (see
`manual-inspection-rule.json`), and nos-03 emitted `[1][2]` with zero sources.

## Rerank arm versus rule

| Metric | rule | rerank |
|---|---|---|
| Citation verification pass rate | 3/14 | 4/14 |
| Citation precision | 31/54 | 36/66 |
| Fetched usable ratio | 43/70 | 44/70 |
| No-source automatic refusal pass | 1/6 | 2/6 |
| No-source manual pass | 1/6 | 3/6 |
| Answerable latency P50 / P90 | 30.0s / 42.4s | 32.1s / 41.6s |
| Rerank calls / failures | — | 18 / 0 |
| Rerank call latency P50 / P90 | — | 0.5s / 1.1s |
| Cases where rerank changed the fetched top-5 | — | 16/18 |

Reading the comparison:

- **Ranking does change what gets fetched**: on 16 of 18 calls the reranked top-5 differed from the
  rule top-5 over the same 3–27 deduped candidates.
- **No measurable quality gain at this sample size.** Answerable differences are one case (3→4 of
  14) and one fetched source (43→44 of 70). The no-source cases show how large run-to-run noise
  is: every fetch there is stubbed to fail, so whichever sources ranking picks, none becomes usable
  and the evidence the model sees is the same kind of failure in both arms. Ranking cannot explain
  their swing from 1/6 to 3/6 — that is LLM variance between two runs, larger than any answerable
  difference.
- **The metric limits what rerank can show.** "Usable" means fetched without error and ≥ 200
  characters; it measures reachability, not relevance, and the dominant failure (synthesis citing
  unusable or unfetched sources) happens after ranking.
- **Cost**: one extra provider call per researched question, P50 0.5s / P90 1.1s, no failures in 18
  calls; end-to-end latency differences between arms (±2s at P50/P90) are within run-to-run noise.
  Rerank token usage was not recorded in this run.

Decision: keep rerank behind the flag, off by default. Enabling it is cheap (~0.5s P50) and
fail-safe, but this evaluation does not show a quality benefit; a relevance label per fetched
source is needed before rerank can be judged on quality.

## Citation guard arm versus rule

The guard (commit ec8c1a3) has two layers: the synthesis evidence numbers only usable sources and
the no-source policy forbids unsupported dates, versions and statuses (prompt layer), then a
deterministic step removes `[n]` markers that do not point at a usable source and URLs that are not
a usable source's URL (post-processing layer). Answers are scored after both layers.

| Metric | rule | guard |
|---|---|---|
| Citation verification pass rate | 3/14 | 14/14 |
| Citation precision | 31/54 | 37/37 |
| No-source automatic refusal pass | 1/6 | 6/6 |
| No-source manual pass (no unsupported claim) | 1/6 | 3/6 |
| Answerable latency P50 / P90 | 30.0s / 42.4s | 29.5s / 43.1s |

How much is the deterministic step:

- It modified 14 of 20 research answers: 10 of 14 answerable (8 markers, 7 URLs removed) and 4 of
  6 no-source (11 markers, 3 URLs removed).
- Without it, the guard arm's own answers would pass citation verification only 4/14 (the four
  unmodified answers) and the automatic refusal check 3/6. That is within the noise seen between
  the rule and rerank arms, so the prompt layer alone shows no measurable citation gain; the
  14/14 and 6/6 are enforced by the post-processing layer.
- Unsupported claims on no-source cases (manual 3/6) are not something the guard can remove; the
  rerank arm, without any guard, also reached 3/6, so this is not a demonstrated improvement.
- Every guarded answerable answer still cites at least one usable source (cited items 37, all
  resolving), so the guard did not strip answers to nothing. Latency cost is a regex pass
  (differences are within run-to-run noise).
- Side effect found in this run: 5 of 26 answers kept empty brackets or a dangling colon where a
  URL was removed (e.g. "官網（）"). Fixed after the run with a unit test; the recorded answers
  predate that fix.

Decision: keep the guard on by default. It guarantees that every citation the user sees points at
a source the graph actually fetched and judged usable, at negligible latency. It does not make the
model ground its claims better; that needs a separate change and evaluation.

## Caveats

- 26 hand-written cases, one run per arm; no gold answers. Live web results change over time.
- The no-source refusal detector is a keyword heuristic; manual inspection was done by the coding
  agent that wrote the evaluation, not an independent reviewer.
- Ran in-process via vitest without Postgres; admission and the authorization decision store were
  no-op doubles. DNS for egress used DoH because the local resolver returned fake-ip answers.
