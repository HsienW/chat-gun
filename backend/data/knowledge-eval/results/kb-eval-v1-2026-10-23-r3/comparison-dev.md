## Retrieval comparison — kb-eval-v1 (dev split)

> All cases completed.

| Configuration | Recall@5 | MRR | Citation accuracy | Faithfulness | Abstention accuracy | False abstention | P50 ms | P95 ms |
|---|---|---|---|---|---|---|---|---|
| vector_only | 0.889 | 0.744 | 1.000 | 0.917 | 1.000 | 0.333 | 1703 | 2974 |
| vector_rerank (degraded 1) | 0.889 | 0.889 | 1.000 | 1.000 | 1.000 | 0.111 | 2566 | 4000 |

**Definitions.** Recall@5 and MRR rank unique sources before the evidence threshold (answerable cases).
Citation accuracy is the share of answer citations that resolve to returned evidence and belong to a relevant source (answered, answerable cases).
Faithfulness is model-assisted (share of supported claims) and is published only with a manual inspection of at least 10 cases.
Abstention accuracy counts abstain cases where the system declined; false abstention counts answerable cases where it declined.

**Provenance.**
dataset kb-eval-v1, corpus kb-v1 (**synthetic**), split dev;
embedding text-embedding-v4 (text-embedding-v4:1024), rerank qwen3-rerank, generation qwen-plus, judge qwen-max;
prompts kb-answer-v1 / kb-faithfulness-v1; threshold kb-threshold-v1; config kb-config-v1;
runs 1; date 2026-10-23;
manual inspection 10/10, judge agreement 0.600.
Figures show method efficacy on a synthetic, controlled dataset, not production performance.
