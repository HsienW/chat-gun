# 評測比較

小樣本，一兩題的差異應視為雜訊。

基準：第一個 run。n 為各指標實際計算的樣本母體；null 表示沒有可計算值。

## Provenance

| 欄位 | run 1 | run 2 |
|---|---|---|
| run | kb-eval-v1-2026-10-27-r2/run-vector_only.json | kb-eval-v1-2026-10-27-r2/run-vector_rerank.json |
| datasetVersion | kb-eval-v1 | kb-eval-v1 |
| corpusVersion | kb-v1 | kb-v1 |
| datasetSha256 | 未記錄 | 未記錄 |
| split | all | all |
| embeddingModel | text-embedding-v4 | text-embedding-v4 |
| embeddingSpaceId | text-embedding-v4:1024 | text-embedding-v4:1024 |
| rerankModel | qwen3-rerank | qwen3-rerank |
| generationModel | qwen-plus | qwen-plus |
| judgeModel | qwen-max | qwen-max |
| plannerModel | 未記錄 | 未記錄 |
| synthesisModel | 未記錄 | 未記錄 |
| llmProvider | 未記錄 | 未記錄 |
| generationProvider | 未記錄 | 未記錄 |
| configuredGenerationModel | 未記錄 | 未記錄 |
| actualGenerationModel | 未記錄 | 未記錄 |
| generationThinkingEnabled | 未記錄 | 未記錄 |
| thinkingEnabled | 未記錄 | 未記錄 |
| generationEndpointHost | 未記錄 | 未記錄 |
| endpointHost | 未記錄 | 未記錄 |
| answerPromptVersion | kb-answer-v1 | kb-answer-v1 |
| judgePromptVersion | kb-faithfulness-v1 | kb-faithfulness-v1 |
| thresholdVersion | kb-threshold-v1 | kb-threshold-v1 |
| configVersion | kb-config-v1 | kb-config-v1 |
| runnerVersion | 未記錄 | 未記錄 |
| runCount | 1 | 1 |
| date | 2026-10-27 | 2026-10-27 |

## 指標

| 指標／split | run | 值 | 相對基準差異 | n |
|---|---|---|---|---|
| all.abstainCases | run 1 | 11 | +0.000000000 | 40 |
| all.abstainCases | run 2 | 11 | +0.000000000 | 40 |
| all.abstentionAccuracy | run 1 | 1.000000000 | +0.000000000 | 11 |
| all.abstentionAccuracy | run 2 | 1.000000000 | +0.000000000 | 11 |
| all.answerableCases | run 1 | 29 | +0.000000000 | 40 |
| all.answerableCases | run 2 | 29 | +0.000000000 | 40 |
| all.cases | run 1 | 40 | +0.000000000 | 40 |
| all.cases | run 2 | 40 | +0.000000000 | 40 |
| all.citationAccuracy | run 1 | 1.000000000 | +0.000000000 | 20 |
| all.citationAccuracy | run 2 | 1.000000000 | +0.000000000 | 26 |
| all.faithfulness | run 1 | 0.975000000 | +0.000000000 | 20 |
| all.faithfulness | run 2 | 0.974358974 | -0.000641026 | 26 |
| all.falseAbstentionRate | run 1 | 0.310344828 | +0.000000000 | 29 |
| all.falseAbstentionRate | run 2 | 0.103448276 | -0.206896552 | 29 |
| all.latencyP50Ms | run 1 | 1944.000000000 | +0.000000000 | 40 |
| all.latencyP50Ms | run 2 | 2561.000000000 | +617.000000000 | 40 |
| all.latencyP95Ms | run 1 | 3121.000000000 | +0.000000000 | 40 |
| all.latencyP95Ms | run 2 | 3547.000000000 | +426.000000000 | 40 |
| all.mrr | run 1 | 0.780028736 | +0.000000000 | 29 |
| all.mrr | run 2 | 0.908045977 | +0.128017241 | 29 |
| all.recallAt5 | run 1 | 0.870689655 | +0.000000000 | 29 |
| all.recallAt5 | run 2 | 0.965517241 | +0.094827586 | 29 |
| dev.abstainCases | run 1 | 3 | +0.000000000 | 12 |
| dev.abstainCases | run 2 | 3 | +0.000000000 | 12 |
| dev.abstentionAccuracy | run 1 | 1.000000000 | +0.000000000 | 3 |
| dev.abstentionAccuracy | run 2 | 1.000000000 | +0.000000000 | 3 |
| dev.answerableCases | run 1 | 9 | +0.000000000 | 12 |
| dev.answerableCases | run 2 | 9 | +0.000000000 | 12 |
| dev.cases | run 1 | 12 | +0.000000000 | 12 |
| dev.cases | run 2 | 12 | +0.000000000 | 12 |
| dev.citationAccuracy | run 1 | 1.000000000 | +0.000000000 | 6 |
| dev.citationAccuracy | run 2 | 1.000000000 | +0.000000000 | 8 |
| dev.faithfulness | run 1 | 0.916666667 | +0.000000000 | 6 |
| dev.faithfulness | run 2 | 1.000000000 | +0.083333333 | 8 |
| dev.falseAbstentionRate | run 1 | 0.333333333 | +0.000000000 | 9 |
| dev.falseAbstentionRate | run 2 | 0.111111111 | -0.222222222 | 9 |
| dev.latencyP50Ms | run 1 | 2014.000000000 | +0.000000000 | 12 |
| dev.latencyP50Ms | run 2 | 2633.000000000 | +619.000000000 | 12 |
| dev.latencyP95Ms | run 1 | 3121.000000000 | +0.000000000 | 12 |
| dev.latencyP95Ms | run 2 | 3436.000000000 | +315.000000000 | 12 |
| dev.mrr | run 1 | 0.744444444 | +0.000000000 | 9 |
| dev.mrr | run 2 | 0.888888889 | +0.144444444 | 9 |
| dev.recallAt5 | run 1 | 0.888888889 | +0.000000000 | 9 |
| dev.recallAt5 | run 2 | 0.888888889 | +0.000000000 | 9 |
| test.abstainCases | run 1 | 8 | +0.000000000 | 28 |
| test.abstainCases | run 2 | 8 | +0.000000000 | 28 |
| test.abstentionAccuracy | run 1 | 1.000000000 | +0.000000000 | 8 |
| test.abstentionAccuracy | run 2 | 1.000000000 | +0.000000000 | 8 |
| test.answerableCases | run 1 | 20 | +0.000000000 | 28 |
| test.answerableCases | run 2 | 20 | +0.000000000 | 28 |
| test.cases | run 1 | 28 | +0.000000000 | 28 |
| test.cases | run 2 | 28 | +0.000000000 | 28 |
| test.citationAccuracy | run 1 | 1.000000000 | +0.000000000 | 14 |
| test.citationAccuracy | run 2 | 1.000000000 | +0.000000000 | 18 |
| test.faithfulness | run 1 | 1.000000000 | +0.000000000 | 14 |
| test.faithfulness | run 2 | 0.962962963 | -0.037037037 | 18 |
| test.falseAbstentionRate | run 1 | 0.300000000 | +0.000000000 | 20 |
| test.falseAbstentionRate | run 2 | 0.100000000 | -0.200000000 | 20 |
| test.latencyP50Ms | run 1 | 1651.000000000 | +0.000000000 | 28 |
| test.latencyP50Ms | run 2 | 2541.000000000 | +890.000000000 | 28 |
| test.latencyP95Ms | run 1 | 3208.000000000 | +0.000000000 | 28 |
| test.latencyP95Ms | run 2 | 3552.000000000 | +344.000000000 | 28 |
| test.mrr | run 1 | 0.796041667 | +0.000000000 | 20 |
| test.mrr | run 2 | 0.916666667 | +0.120625000 | 20 |
| test.recallAt5 | run 1 | 0.862500000 | +0.000000000 | 20 |
| test.recallAt5 | run 2 | 1.000000000 | +0.137500000 | 20 |
