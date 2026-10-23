## Retrieval comparison — kb-eval-v1 (test split)

> All cases completed.

| Configuration | Recall@5 | MRR | Citation accuracy | Faithfulness | Abstention accuracy | False abstention | P50 ms | P95 ms |
|---|---|---|---|---|---|---|---|---|
| vector_only | 0.863 | 0.796 | 0.972 | 0.926 (pending manual inspection) | 1.000 | 0.100 | 2437 | 4411 |
| vector_rerank | 1.000 | 0.917 | 0.975 | 0.958 (pending manual inspection) | 1.000 | 0.000 | 2662 | 4845 |

**Definitions.** Recall@5 and MRR rank unique sources before the evidence threshold (answerable cases).
Citation accuracy is the share of answer citations that resolve to returned evidence and belong to a relevant source (answered, answerable cases).
Faithfulness is model-assisted (share of supported claims) and is published only with a manual inspection of at least 10 cases.
Abstention accuracy counts abstain cases where the system declined; false abstention counts answerable cases where it declined.

**Provenance.**
dataset kb-eval-v1, corpus kb-v1 (**synthetic**), split test;
embedding text-embedding-v4 (text-embedding-v4:1024), rerank qwen3-rerank, generation qwen-plus, judge qwen-max;
prompts kb-answer-v1 / kb-faithfulness-v1; threshold kb-threshold-v0; config kb-config-v1;
runs 1; date 2026-10-23;
manual inspection 0/10.
Figures show method efficacy on a synthetic, controlled dataset, not production performance.
