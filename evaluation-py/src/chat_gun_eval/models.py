"""Versioned reader contract; TS optional additions remain forward compatible."""

from typing import Annotated, Literal, Self, get_args

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    TypeAdapter,
    field_validator,
    model_validator,
)

INPUT_MODEL_VERSION = "evaluation-analysis@1"
type Split = Literal["dev", "test"]
type ExpectedKind = Literal["answerable", "abstain"]
type KBCaseStatus = Literal["completed", "failed"]
type KBRunStatus = Literal["completed", "incomplete"]
type Strategy = Literal["vector_only", "vector_rerank"]
type Category = Literal["answerable", "no_source", "clarify"]
type ResearchStatus = Literal["completed", "failed", "timeout"]
type Ranking = Literal["rule", "rerank", "guard"]
type Stage = Literal["embedding", "recall", "rerank", "generation", "judge"]
SPLITS: tuple[str, ...] = get_args(Split.__value__)
CATEGORIES: tuple[str, ...] = get_args(Category.__value__)
STAGES: tuple[str, ...] = get_args(Stage.__value__)
Name = Annotated[str, StringConstraints(min_length=1)]
Milliseconds = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Number = Annotated[float, Field(allow_inf_nan=False)]
type JsonObject = dict[str, JsonValue]
JSON_OBJECT = TypeAdapter[JsonObject](dict[str, JsonValue])


class InputModel(BaseModel):
    model_config = ConfigDict(
        extra="allow", strict=True, populate_by_name=True, allow_inf_nan=False
    )


class Timing(InputModel):
    status: Literal["completed", "failed", "not_run"]
    ms: Milliseconds | None = None

    @model_validator(mode="after")
    def measured_timing(self) -> Self:
        if self.status != "not_run" and self.ms is None:
            raise ValueError("ms is required for completed/failed timing")
        return self


class StageLatency(InputModel):
    embedding: Timing
    recall: Timing
    rerank: Timing
    generation: Timing
    judge: Timing


class KBCaseBase(InputModel):
    caseId: Name
    split: Split
    expectedKind: ExpectedKind
    latencyMs: Milliseconds
    stageLatency: StageLatency | None = None

    @field_validator("stageLatency", mode="before")
    @classmethod
    def present_stage_is_not_null(cls, value: object) -> object:
        if value is None:
            raise ValueError("omit an unmeasured stageLatency; null is not a TS StageLatency")
        return value


class CandidateScore(InputModel):
    sourceId: str
    similarity: Number
    rerankScore: Number | None = None


class KBCompleted(KBCaseBase):
    status: Literal["completed"]
    abstained: bool
    retrievalMode: str
    kbOutcome: Literal["evidence_found", "no_source_found"]
    rankedSourceIds: list[str]
    candidateScores: list[CandidateScore]
    recallAt5: Number | None = None
    reciprocalRank: Number | None = None
    citationAccuracy: Number | None = None
    faithfulness: Number | None = None

    @field_validator(
        "recallAt5", "reciprocalRank", "citationAccuracy", "faithfulness", mode="before"
    )
    @classmethod
    def present_metric_is_not_null(cls, value: object) -> object:
        if value is None:
            raise ValueError("omit an unmeasured metric; null is not a TS case number")
        return value


class KBFailed(KBCaseBase):
    status: Literal["failed"]
    errorCode: Name


KBCase = Annotated[KBCompleted | KBFailed, Field(discriminator="status")]


class StageSummary(InputModel):
    completed: int
    failed: int
    notRun: int
    unmeasured: int
    p50Ms: Number | None
    p95Ms: Number | None


class StageSummaries(InputModel):
    embedding: StageSummary
    recall: StageSummary
    rerank: StageSummary
    generation: StageSummary
    judge: StageSummary


class KBSummary(InputModel):
    cases: int
    answerableCases: int
    abstainCases: int
    recallAt5: Number | None
    mrr: Number | None
    citationAccuracy: Number | None
    faithfulness: Number | None
    abstentionAccuracy: Number | None
    falseAbstentionRate: Number | None
    latencyP50Ms: Number | None
    latencyP95Ms: Number | None
    # Older TS summaries predate these additions; recorded() preserves their absence.
    stageLatency: StageSummaries | None = None
    retrievalP50Ms: Number | None = None
    retrievalP95Ms: Number | None = None
    degradedCases: int | None = None


class KBSummaries(InputModel):
    dev: KBSummary
    test: KBSummary
    all: KBSummary


class KBRun(InputModel):
    strategy: Strategy
    status: KBRunStatus
    failedCases: list[str]
    results: list[KBCase]
    summary: KBSummaries
    datasetVersion: Name | None = None


class Source(InputModel):
    index: int
    url: str
    usable: bool


class Rerank(InputModel):
    ok: bool
    latencyMs: Milliseconds
    candidates: int
    selected: int
    changedSelections: int | None


class CitationGuard(InputModel):
    modified: bool
    removedMarkers: int
    removedUrls: int


class Observation(InputModel):
    caseId: Name
    category: Category
    status: ResearchStatus
    latencyMs: Milliseconds
    queries: list[str]
    searchResultCount: int
    rankedUrls: list[str]
    sources: list[Source]
    answer: str
    answerMode: str | None = None
    stub: Literal["empty_search", "fetch_fail"] | None = None
    rerank: Rerank | None = None
    citationGuard: CitationGuard | None = None

    @field_validator("answerMode", "stub", "rerank", "citationGuard", mode="before")
    @classmethod
    def present_observation_field_is_not_null(cls, value: object) -> object:
        if value is None:
            raise ValueError(
                "omit an unavailable optional field; null is not a TS observation value"
            )
        return value


class Citation(InputModel):
    markers: list[int]
    urls: list[str]
    citedCount: int
    usableCitedCount: int
    unresolved: list[str]
    pass_: bool | None = Field(alias="pass")


class Refusal(InputModel):
    usableSourceCount: int
    limitationStated: bool
    citedEvidence: bool
    urlsMentioned: list[str]
    pass_: bool = Field(alias="pass")


class Score(InputModel):
    caseId: Name
    category: Category
    citation: Citation
    refusal: Refusal | None = None
    clarifyPass: bool | None = None


class Rate(InputModel):
    passed: int
    n: int
    rate: Number | None


class RefusalRate(Rate):
    stubEffective: int


class CitationSummary(InputModel):
    answerPassRate: Rate
    citationPrecision: Rate
    answerableWithoutCitation: int
    answerableWithZeroUsableSources: int
    allCategoriesAnswerPassRate: Rate


class LatencySummary(InputModel):
    n: int
    p50Ms: Number | None
    p90Ms: Number | None
    meanMs: Number | None


class ResearchLatencies(InputModel):
    all: LatencySummary
    answerable: LatencySummary
    no_source: LatencySummary
    clarify: LatencySummary


class RerankSummary(InputModel):
    calls: int
    failed: int
    latency: LatencySummary
    casesWithChangedSelection: Rate


class GuardSummary(InputModel):
    answersModified: Rate
    removedMarkers: int
    removedUrls: int


class ResearchSummary(InputModel):
    cases: int
    completed: int
    failedOrTimeout: int
    citation: CitationSummary
    refusal: RefusalRate
    clarify: Rate
    fetchedUsable: Rate
    routing: dict[str, int]
    latency: ResearchLatencies
    rerank: RerankSummary | None = None
    citationGuard: GuardSummary | None = None


class ResearchRun(InputModel):
    runnerVersion: Name
    datasetVersion: Name
    ranking: Ranking
    observations: list[Observation]
    scores: list[Score]
    summary: ResearchSummary


class Provenance(InputModel):
    datasetVersion: Name
    corpusVersion: Name | None = None
    split: Literal["dev", "test", "all"] | None = None
    date: str | None = None
    datasetSha256: str | None = None
    embeddingModel: str | None = None
    embeddingSpaceId: str | None = None
    rerankModel: str | None = None
    generationModel: str | None = None
    judgeModel: str | None = None
    plannerModel: str | None = None
    synthesisModel: str | None = None
    llmProvider: str | None = None
    generationProvider: str | None = None
    configuredGenerationModel: str | None = None
    actualGenerationModel: str | None = None
    generationThinkingEnabled: bool | None = None
    thinkingEnabled: bool | None = None
    generationEndpointHost: str | None = None
    endpointHost: str | None = None
    answerPromptVersion: str | None = None
    judgePromptVersion: str | None = None
    thresholdVersion: str | None = None
    configVersion: str | None = None
    runnerVersion: str | None = None
    runCount: int | None = None


def json_object(value: object) -> JsonObject:
    """Validate nested output without introducing untyped dictionaries at boundaries."""
    return JSON_OBJECT.validate_python(value)
