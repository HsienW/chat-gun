import { describe, expect, it } from "vitest";

import { deepResearcherQueryContractTestInternals } from "./deep-researcher.js";

type ContractState = Parameters<
  typeof deepResearcherQueryContractTestInternals.routeAfterPlan
>[0];

function stateWithPlan(
  plan: NonNullable<ContractState["plan"]>
): ContractState {
  return {
    executionTaskId: undefined,
    plan,
    contextPack: undefined,
    initial_search_query_count: 2,
    max_research_loops: 5,
    reasoning_model: "",
    messages: [],
    searchResults: [],
    rankedSources: [],
    fetchedSources: [],
    extractedSources: [],
    verification: undefined,
    uploadError: undefined,
    imageObservations: [],
    weatherExecution: undefined,
    clarification: undefined,
  };
}

describe("deep researcher query workflow contract", () => {
  it("captures structured output parse failures without exposing raw parser exceptions", () => {
    const result =
      deepResearcherQueryContractTestInternals.parseJsonObjectWithDiagnostics("{not-json");

    expect(result).toEqual({
      failureCode: "parse_failed",
      responseContentLength: 9,
    });
  });

  it("coerces invalid calculation structured output into a clarification plan", () => {
    const state = stateWithPlan({
      question: "What is 2+2?",
      answerMode: "research",
      rationale: "fallback",
      queries: ["What is 2+2?"],
      urls: [],
      requiredSourceCount: 1,
    });

    const plan = deepResearcherQueryContractTestInternals.coercePlan(
      {
        answerMode: "calculation",
        rationale: "calculation requires a tool",
      },
      "What is 2+2?",
      state
    );

    expect(plan.answerMode).toBe("clarify");
    expect(plan.calculation).toBeUndefined();
    expect(plan.clarification).toBeTruthy();
  });

  it("routes supported answer modes through stable graph route constants", () => {
    const basePlan = {
      question: "Explain TypeScript",
      rationale: "route test",
      queries: ["TypeScript"],
      urls: [],
      requiredSourceCount: 1,
    };

    expect(
      deepResearcherQueryContractTestInternals.routeAfterPlan(
        stateWithPlan({ ...basePlan, answerMode: "research" })
      )
    ).toBe("search_web");
    expect(
      deepResearcherQueryContractTestInternals.routeAfterPlan(
        stateWithPlan({
          ...basePlan,
          answerMode: "calculation",
          calculation: { expression: "2+2" },
        })
      )
    ).toBe("targeted_tools");
    expect(
      deepResearcherQueryContractTestInternals.routeAfterPlan(
        stateWithPlan({
          ...basePlan,
          answerMode: "weather",
          weather: { location: "Kaohsiung Daliao" },
        })
      )
    ).toBe("targeted_tools");
    expect(
      deepResearcherQueryContractTestInternals.routeAfterPlan(
        stateWithPlan({ ...basePlan, answerMode: "clarify", clarification: "Need detail." })
      )
    ).toBe("synthesize");
  });
});
