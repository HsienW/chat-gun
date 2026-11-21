import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { deepResearcherWeatherTestInternals } from "./deep-researcher.js";
import { describeLlmGatewayConfig } from "../platform/llm-gateway.js";

const runLiveSmoke =
  process.env.RUN_DEEP_RESEARCHER_WEATHER_LIVE_SMOKE === "true";
const liveDescribe = runLiveSmoke ? describe : describe.skip;
const liveSmokeTimeoutMs = 90_000;

const acceptanceCases = [
  {
    question: "大寮天氣",
    expectedAnswerMode: "weather",
    expectedToolStatus: "needs_clarification",
  },
  {
    question: "高雄大寮今天會下雨嗎",
    expectedAnswerMode: "weather",
    expectedToolStatus: "success",
  },
] as const;

liveDescribe("deep researcher weather live smoke", () => {
  it.each(acceptanceCases)(
    "plans $question as $expectedAnswerMode with the configured provider",
    async ({ question, expectedAnswerMode, expectedToolStatus }) => {
      const state = ({
        messages: [new HumanMessage(question)],
        imageRecognition: undefined, imageObservations: [],
        initial_search_query_count: 3,
        max_research_loops: 6,
        reasoning_model: "qwen-plus",
      } as unknown) as Parameters<
        typeof deepResearcherWeatherTestInternals.planResearch
      >[0];

      const planned = await deepResearcherWeatherTestInternals.planResearch(state, {});
      console.info("deep_researcher_weather_live_summary", JSON.stringify({
        provider: describeLlmGatewayConfig(),
        question,
        plan: planned.plan,
      }));

      expect(planned.plan?.answerMode).toBe(expectedAnswerMode);
      if (expectedAnswerMode === "weather") {
        expect(planned.plan?.weather?.location.trim()).toBeTruthy();
        expect(
          deepResearcherWeatherTestInternals.routeAfterPlan({
            ...state,
            plan: planned.plan,
          } as Parameters<typeof deepResearcherWeatherTestInternals.routeAfterPlan>[0])
        ).toBe("targeted_tools");

        const toolResult = await deepResearcherWeatherTestInternals.targetedTools(
          {
            ...state,
            plan: planned.plan,
          } as Parameters<typeof deepResearcherWeatherTestInternals.targetedTools>[0],
          {}
        );
        console.info("deep_researcher_weather_live_tool_summary", JSON.stringify({
          question,
          weatherExecution: toolResult.weatherExecution,
        }));
        expect(toolResult.weatherExecution?.status).toBe(expectedToolStatus);
      }
    },
    liveSmokeTimeoutMs
  );

  it("safely requests a location when the user asks only about tomorrow", async () => {
    const question = "明天會下雨嗎";
    const state = ({
      messages: [new HumanMessage(question)],
      imageRecognition: undefined, imageObservations: [],
      initial_search_query_count: 3,
      max_research_loops: 6,
      reasoning_model: "qwen-plus",
    } as unknown) as Parameters<
      typeof deepResearcherWeatherTestInternals.planResearch
    >[0];

    const planned = await deepResearcherWeatherTestInternals.planResearch(state, {});
    if (planned.plan?.answerMode === "clarify") {
      expect(planned.plan.weather).toBeUndefined();
      expect(planned.plan.clarification).toBeTruthy();
      return;
    }

    expect(planned.plan?.answerMode).toBe("weather");
    const toolResult = await deepResearcherWeatherTestInternals.targetedTools(
      {
        ...state,
        plan: planned.plan,
      } as Parameters<typeof deepResearcherWeatherTestInternals.targetedTools>[0],
      {}
    );
    console.info("deep_researcher_weather_live_missing_location_summary", JSON.stringify({
      plan: planned.plan,
      weatherExecution: toolResult.weatherExecution,
    }));

    expect(toolResult.weatherExecution?.status).toBe("failed");
    if (toolResult.weatherExecution?.status === "failed") {
      expect(toolResult.weatherExecution.result.status).toBe("not_found");
    }
  }, liveSmokeTimeoutMs);
});
