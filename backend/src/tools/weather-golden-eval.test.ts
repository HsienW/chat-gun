import { afterEach, describe, expect, it, vi } from "vitest";

import { installEgressPolicyTestTransport } from "../runtime/tool-dispatch/egress-policy.testing.js";
import {
  WEATHER_GOLDEN_EVAL_CASES,
  evaluateWeatherGoldenCase,
  sanitizeWeatherGoldenDiagnostics,
  summarizeWeatherGoldenEvalResults,
} from "./weather-golden-eval.js";
import { weatherTool } from "./weather.js";
import type { WeatherToolResult } from "./weather-types.js";

installEgressPolicyTestTransport();

type OpenMeteoResult = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  timezone?: string;
  population?: number;
};

const TAIPEI = "\u53f0\u5317";
const TAIPEI_TRADITIONAL = "\u81fa\u5317";
const SINGAPORE_ZH = "\u65b0\u52a0\u5761";

const goldenCandidates: Record<string, OpenMeteoResult[]> = {
  taipei: [
    {
      name: "Taipei",
      latitude: 25.033,
      longitude: 121.565,
      country: "Taiwan",
      country_code: "TW",
      admin1: "Taipei City",
      timezone: "Asia/Taipei",
      population: 7_000_000,
    },
  ],
  tokyo: [
    {
      name: "Tokyo",
      latitude: 35.676,
      longitude: 139.65,
      country: "Japan",
      country_code: "JP",
      admin1: "Tokyo",
      timezone: "Asia/Tokyo",
      population: 14_000_000,
    },
  ],
  singapore: [
    {
      name: "Singapore",
      latitude: 1.352,
      longitude: 103.82,
      country: "Singapore",
      country_code: "SG",
      timezone: "Asia/Singapore",
      population: 5_600_000,
    },
  ],
  springfield: [
    {
      name: "Springfield",
      latitude: 39.781,
      longitude: -89.65,
      country: "United States",
      country_code: "US",
      admin1: "Illinois",
      timezone: "America/Chicago",
      population: 114_000,
    },
    {
      name: "Springfield",
      latitude: 37.215,
      longitude: -93.298,
      country: "United States",
      country_code: "US",
      admin1: "Missouri",
      timezone: "America/Chicago",
      population: 168_000,
    },
  ],
  "s\u00e3o paulo": [
    {
      name: "S\u00e3o Paulo",
      latitude: -23.55,
      longitude: -46.633,
      country: "Brazil",
      country_code: "BR",
      admin1: "S\u00e3o Paulo",
      timezone: "America/Sao_Paulo",
      population: 12_000_000,
    },
  ],
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { "content-type": "application/json" },
  });
}

function installGoldenEvalFetchMock(scenario: "normal" | "provider_error" | "timeout" = "normal"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const signal = init?.signal;

      if (scenario === "timeout") {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }

      if (url.hostname === "geocoding-api.open-meteo.com") {
        if (signal?.aborted) {
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        if (scenario === "provider_error") {
          return Promise.resolve(jsonResponse({ reason: "geocoding unavailable" }, { status: 503 }));
        }

        const name = (url.searchParams.get("name") ?? "").toLowerCase();
        return Promise.resolve(jsonResponse({ results: goldenCandidates[name] ?? [] }));
      }

      if (url.hostname === "api.open-meteo.com") {
        if (signal?.aborted) {
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        return Promise.resolve(
          jsonResponse({
            latitude: Number(url.searchParams.get("latitude")),
            longitude: Number(url.searchParams.get("longitude")),
            timezone: "UTC",
            current: {
              time: "2026-06-14T12:00",
              temperature_2m: 24,
              apparent_temperature: 25,
              relative_humidity_2m: 70,
              precipitation: 0,
              rain: 0,
              weather_code: 1,
              cloud_cover: 20,
              pressure_msl: 1012,
              wind_speed_10m: 8,
              wind_direction_10m: 90,
              wind_gusts_10m: 12,
            },
            current_units: {
              temperature_2m: "\u00b0C",
              apparent_temperature: "\u00b0C",
              relative_humidity_2m: "%",
              precipitation: "mm",
              rain: "mm",
              cloud_cover: "%",
              pressure_msl: "hPa",
              wind_speed_10m: "km/h",
              wind_direction_10m: "\u00b0",
              wind_gusts_10m: "km/h",
            },
          })
        );
      }

      return Promise.reject(new Error(`Unexpected network call: ${url.toString()}`));
    })
  );
}

async function invokeWeather(input: {
  location: string;
  queryName?: string;
  country?: string;
  region?: string;
}, signal?: AbortSignal): Promise<WeatherToolResult> {
  const raw = await weatherTool.invoke(input, signal ? { signal } : undefined);
  return JSON.parse(String(raw)) as WeatherToolResult;
}

function caseById(id: string) {
  const found = WEATHER_GOLDEN_EVAL_CASES.find((testCase) => testCase.id === id);
  if (!found) {
    throw new Error(`Missing golden eval case: ${id}`);
  }
  return found;
}

describe("weather golden eval matrix", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("covers current, forecast, ambiguous, missing-location, failure, timeout, cancellation, and clarification boundaries", () => {
    const categories = new Set(WEATHER_GOLDEN_EVAL_CASES.map((testCase) => testCase.capabilityCategory));
    expect(categories).toEqual(
      new Set([
        "current_observation",
        "daily_forecast",
        "hourly_forecast",
        "ambiguous_location",
        "missing_location",
        "provider_error",
        "timeout",
        "cancelled",
        "planner_error",
        "synthesis_error",
        "clarification",
        "relationship",
      ])
    );
  });

  it("classifies Phase 2 forecast and Phase 3 clarification cases as pass", () => {
    const results = [
      evaluateWeatherGoldenCase(caseById("WGE-FORECAST-TOMORROW"), {
        status: "success",
        summary: "Daily weather_forecast returned tomorrow precipitation probability.",
      }),
      evaluateWeatherGoldenCase(caseById("WGE-FORECAST-TONIGHT"), {
        status: "success",
        summary: "Hourly weather_forecast returned tonight temperature buckets.",
      }),
      evaluateWeatherGoldenCase(caseById("WGE-FORECAST-WEEKEND"), {
        status: "success",
        summary: "Daily weather_forecast returned weekend forecast entries.",
      }),
      evaluateWeatherGoldenCase(caseById("WGE-MULTITURN-CANDIDATE-KNOWN-GAP"), {
        status: "success",
        summary: "Candidate follow-up continued through clarification.",
      }),
      evaluateWeatherGoldenCase(caseById("clarification-candidate-index"), {
        status: "success",
        summary: "Selected first candidate.",
      }),
      evaluateWeatherGoldenCase(caseById("clarification-region-supplement"), {
        status: "success",
        summary: "Filtered by Illinois.",
      }),
      evaluateWeatherGoldenCase(caseById("clarification-location-change"), {
        status: "success",
        summary: "Changed to Tokyo.",
      }),
      evaluateWeatherGoldenCase(caseById("clarification-cancel"), {
        status: "error",
        code: "weather_cancelled",
        summary: "User cancelled clarification.",
      }),
      evaluateWeatherGoldenCase(caseById("clarification-unrecognizable-reply"), {
        status: "needs_clarification",
        summary: "Asked for more detail.",
      }),
      evaluateWeatherGoldenCase(caseById("clarification-ambiguous-forecast"), {
        status: "success",
        summary: "Forecast resumed after clarification.",
      }),
    ];

    expect(results.map((result) => result.classification)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(results.every((result) => result.owner === undefined)).toBe(true);
  });

  it("marks live smoke cases as skipped by default", () => {
    const result = evaluateWeatherGoldenCase(caseById("WGE-LIVE-TAIPEI-OPT-IN"), undefined, {
      liveSmokeEnabled: false,
    });

    expect(result.classification).toBe("skipped");
    expect(result.observedSummary).toContain("not enabled");
  });

  it("can classify missing-location and opt-in live smoke outcomes without relying on display text", () => {
    const missingLocation = evaluateWeatherGoldenCase(caseById("WGE-MISSING-LOCATION"), {
      status: "error",
      code: "weather_invalid_input",
      summary: "Planner should clarify before invoking current_weather.",
    });
    const liveSmoke = evaluateWeatherGoldenCase(
      caseById("WGE-LIVE-TAIPEI-OPT-IN"),
      {
        status: "success",
        summary: "Live provider resolved Taipei.",
      },
      { liveSmokeEnabled: true }
    );

    expect(missingLocation.classification).toBe("pass");
    expect(liveSmoke.classification).toBe("pass");
  });

  it("redacts sensitive diagnostics before report output", () => {
    const sanitized = sanitizeWeatherGoldenDiagnostics({
      apiKey: "sk-secret-value",
      authorization: "Bearer token",
      nested: {
        prompt: "full prompt should not be emitted",
        safe: "kept",
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain("sk-secret-value");
    expect(JSON.stringify(sanitized)).not.toContain("Bearer token");
    expect(JSON.stringify(sanitized)).not.toContain("full prompt");
    expect(JSON.stringify(sanitized)).toContain("[redacted]");
    expect(JSON.stringify(sanitized)).toContain("kept");
  });

  it("summarizes pass, fail, known gap, and skipped classifications", () => {
    const summary = summarizeWeatherGoldenEvalResults([
      { caseId: "a", mode: "deterministic", classification: "pass", expectedSummary: "", observedSummary: "" },
      { caseId: "b", mode: "mock_integration", classification: "fail", expectedSummary: "", observedSummary: "" },
      { caseId: "c", mode: "deterministic", classification: "known_gap", expectedSummary: "", observedSummary: "" },
      { caseId: "d", mode: "live_smoke", classification: "skipped", expectedSummary: "", observedSummary: "" },
    ]);

    expect(summary).toEqual({ total: 4, pass: 1, fail: 1, knownGap: 1, skipped: 1 });
  });

  it("records malformed Planner output and synthesis failure as structured deterministic failures", () => {
    const plannerFailure = evaluateWeatherGoldenCase(caseById("WGE-MALFORMED-PLANNER-OUTPUT"), {
      status: "error",
      code: "weather_planner_parse_failed",
      summary: "Planner JSON parse failed.",
    });
    const synthesisFailure = evaluateWeatherGoldenCase(caseById("WGE-SYNTHESIS-FAILURE-AFTER-TOOL-SUCCESS"), {
      status: "error",
      code: "weather_synthesis_failed",
      summary: "Synthesis failed after tool success.",
    });

    expect(plannerFailure.classification).toBe("pass");
    expect(synthesisFailure.classification).toBe("pass");
  });

  it("evaluates mock integration success, ambiguity, not_found, provider error, timeout, and cancellation", async () => {
    installGoldenEvalFetchMock();

    const taipei = await invokeWeather({ location: TAIPEI, queryName: "Taipei" });
    const tokyo = await invokeWeather({ location: "Tokyo" });
    const singapore = await invokeWeather({ location: SINGAPORE_ZH, queryName: "Singapore" });
    const saoPaulo = await invokeWeather({ location: "S\u00e3o Paulo" });
    const ambiguous = await invokeWeather({ location: "Springfield" });
    const notFound = await invokeWeather({ location: "Definitely Missing Place" });

    installGoldenEvalFetchMock("provider_error");
    const providerError = await invokeWeather({ location: "Tokyo" });

    vi.unstubAllGlobals();
    vi.stubEnv("WEATHER_GEOCODING_TIMEOUT_MS", "1");
    installGoldenEvalFetchMock("timeout");
    const timeout = await invokeWeather({ location: "Tokyo" });

    vi.unstubAllGlobals();
    installGoldenEvalFetchMock();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await invokeWeather({ location: "Tokyo" }, controller.signal);

    const results = [
      evaluateWeatherGoldenCase(caseById("WGE-CURRENT-CJK-TAIPEI"), taipei),
      evaluateWeatherGoldenCase(caseById("WGE-CURRENT-EN-TOKYO"), tokyo),
      evaluateWeatherGoldenCase(caseById("WGE-CURRENT-MIXED-SINGAPORE"), singapore),
      evaluateWeatherGoldenCase(caseById("WGE-CURRENT-UNICODE-SAO-PAULO"), saoPaulo),
      evaluateWeatherGoldenCase(caseById("WGE-AMBIGUOUS-SPRINGFIELD"), ambiguous),
      evaluateWeatherGoldenCase(caseById("WGE-NOT-FOUND"), notFound),
      evaluateWeatherGoldenCase(caseById("WGE-PROVIDER-ERROR"), providerError),
      evaluateWeatherGoldenCase(caseById("WGE-TIMEOUT"), timeout),
      evaluateWeatherGoldenCase(caseById("WGE-CANCELLED"), cancelled),
    ];

    expect(results.map((result) => result.classification)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(taipei.status).toBe("success");
    expect(tokyo.status).toBe("success");
    expect(singapore.status).toBe("success");
    expect(saoPaulo.status).toBe("success");
    expect(ambiguous.status).toBe("needs_clarification");
    expect(notFound.status).toBe("not_found");
    expect(providerError.status).toBe("error");
    expect(timeout.status).toBe("error");
    expect(cancelled.status).toBe("error");
  });

  it("records Taipei variant relationship compatibility without changing runtime resolution", () => {
    const result = evaluateWeatherGoldenCase(caseById("WGE-RELATION-TAIPEI-VARIANTS"), {
      status: "success",
      summary: `${TAIPEI} and ${TAIPEI_TRADITIONAL} resolve to TW-compatible entities.`,
    });

    expect(result.classification).toBe("pass");
  });
});
