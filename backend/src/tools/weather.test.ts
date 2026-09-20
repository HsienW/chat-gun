// Weather Tool Unit Tests — Task 4.13
// Tests weather tool structured result contract, status handling, and error conditions.

import { afterEach, describe, it, expect, vi } from "vitest";
import { describeWeatherCode, describeWindDirection, getWeatherConfig, weatherForecastTool, weatherTool } from "./weather.js";
import {
  WeatherToolResult,
  WeatherSuccessResult,
  WeatherClarificationResult,
  WeatherNotFoundResult,
  WeatherErrorResult,
  WeatherForecastResult,
} from "./weather-types.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { "content-type": "application/json" },
  });
}

function installForecastFetchMock(
  scenario: "normal" | "ambiguous" | "geocoding_error" | "forecast_error" | "timeout" = "normal"
): void {
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
        if (scenario === "geocoding_error") {
          return Promise.resolve(jsonResponse({ reason: "geocoding unavailable" }, { status: 503 }));
        }
        const name = (url.searchParams.get("name") ?? "").toLowerCase();
        if (name === "springfield" || scenario === "ambiguous") {
          return Promise.resolve(jsonResponse({
            results: [
              { name: "Springfield", latitude: 39.781, longitude: -89.65, country: "United States", country_code: "US", admin1: "Illinois", timezone: "America/Chicago", population: 114000 },
              { name: "Springfield", latitude: 37.215, longitude: -93.298, country: "United States", country_code: "US", admin1: "Missouri", timezone: "America/Chicago", population: 168000 },
            ],
          }));
        }
        if (name === "missing place") {
          return Promise.resolve(jsonResponse({ results: [] }));
        }
        return Promise.resolve(jsonResponse({
          results: [
            { name: "Taipei", latitude: 25.033, longitude: 121.565, country: "Taiwan", country_code: "TW", admin1: "Taipei City", timezone: "Asia/Taipei", population: 7000000 },
          ],
        }));
      }

      if (url.hostname === "api.open-meteo.com") {
        if (scenario === "forecast_error") {
          return Promise.resolve(jsonResponse({ reason: "forecast unavailable" }, { status: 503 }));
        }
        if (url.searchParams.has("daily")) {
          return Promise.resolve(jsonResponse({
            latitude: 25.033,
            longitude: 121.565,
            timezone: "Asia/Taipei",
            daily: {
              time: ["2026-06-24", "2026-06-25"],
              weather_code: [61, 1],
              temperature_2m_max: [31, 33],
              temperature_2m_min: [25, 26],
              precipitation_probability_max: [80, 20],
              precipitation_sum: [8, 0],
            },
            daily_units: {
              temperature_2m_max: "\u00b0C",
              temperature_2m_min: "\u00b0C",
              precipitation_probability_max: "%",
              precipitation_sum: "mm",
            },
          }));
        }
        return Promise.resolve(jsonResponse({
          latitude: 25.033,
          longitude: 121.565,
          timezone: "Asia/Taipei",
          hourly: {
            time: ["2026-06-23T18:00", "2026-06-23T21:00"],
            temperature_2m: [27, 25],
            precipitation_probability: [40, 70],
            precipitation: [0.1, 2.4],
            weather_code: [3, 61],
          },
          hourly_units: {
            temperature_2m: "\u00b0C",
            precipitation_probability: "%",
            precipitation: "mm",
          },
        }));
      }

      return Promise.reject(new Error(`Unexpected network call: ${url.toString()}`));
    })
  );
}

type ForecastToolTestInput = {
  location: string;
  country?: string;
  region?: string;
  queryName?: string;
  weatherCapability: "hourly" | "daily";
  timeRange: {
    kind: "today" | "tonight" | "tomorrow" | "weekend" | "date_range";
    startDate?: string;
    endDate?: string;
    timezone?: string;
    granularity?: "hourly" | "daily";
  };
  units?: "metric";
  locale?: string;
};

async function invokeForecast(input: ForecastToolTestInput, signal?: AbortSignal): Promise<WeatherForecastResult> {
  const raw = await weatherForecastTool.invoke(input, signal ? { signal } : undefined);
  return JSON.parse(String(raw)) as WeatherForecastResult;
}

describe("Weather Code descriptions", () => {
  it("should describe clear sky (code 0)", () => {
    const text = describeWeatherCode(0);
    expect(text).toBe("clear sky");
  });

  it("should describe rain (codes 61-65)", () => {
    expect(describeWeatherCode(61)).toBe("rain");
    expect(describeWeatherCode(65)).toBe("rain");
  });

  it("should describe snow showers (codes 85-86)", () => {
    expect(describeWeatherCode(85)).toBe("snow showers");
  });

  it("should return fallback for unknown code", () => {
    expect(describeWeatherCode(999)).toBe("unknown weather condition");
  });

  it("should handle undefined code", () => {
    expect(describeWeatherCode(undefined)).toBe("unknown weather condition");
  });
});

describe("Wind direction descriptions", () => {
  it("should describe cardinal directions", () => {
    expect(describeWindDirection(0)).toBe("N");
    expect(describeWindDirection(90)).toBe("E");
    expect(describeWindDirection(180)).toBe("S");
    expect(describeWindDirection(270)).toBe("W");
  });

  it("should describe intercardinal directions", () => {
    expect(describeWindDirection(45)).toBe("NE");
    expect(describeWindDirection(135)).toBe("SE");
    expect(describeWindDirection(225)).toBe("SW");
    expect(describeWindDirection(315)).toBe("NW");
  });

  it("should handle undefined", () => {
    expect(describeWindDirection(undefined)).toBe("unknown");
  });

  it("should wrap degrees beyond 360", () => {
    expect(describeWindDirection(360)).toBe("N");
    expect(describeWindDirection(450)).toBe("E");
  });
});

describe("WeatherToolResult contract (Task 4.1-4.8)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("should have schemaVersion '1.0' and tool 'current_weather' (Task 4.2)", () => {
    const success: WeatherSuccessResult = {
      schemaVersion: "1.0",
      tool: "current_weather",
      status: "success",
      requestedLocation: { raw: "Tokyo", location: "Tokyo" },
      resolvedLocation: {
        provider: "open-meteo",
        name: "Tokyo",
        displayName: "Tokyo, Japan",
        countryCode: "JP",
        latitude: 35.676,
        longitude: 139.65,
        timezone: "Asia/Tokyo",
      },
      observedAt: "2024-01-01T12:00",
      timezone: "Asia/Tokyo",
      current: {
        conditionText: "clear sky",
        temperature: 20,
      },
      units: { temperature_2m: "°C" },
      provider: "Open-Meteo",
      sourceUrl: "https://api.open-meteo.com/v1/forecast",
      summary: "Current weather for Tokyo: 20°C, clear sky.",
    };
    expect(success.schemaVersion).toBe("1.0");
    expect(success.tool).toBe("current_weather");
    expect(success.status).toBe("success");
    expect(success.summary).toBeTruthy();
  });

  it("should produce needs_clarification with candidates (Task 4.4)", () => {
    const clarification: WeatherClarificationResult = {
      schemaVersion: "1.0",
      tool: "current_weather",
      status: "needs_clarification",
      requestedLocation: { raw: "Springfield", location: "Springfield" },
      candidates: [
        { name: "Springfield", displayName: "Springfield, Illinois", country: "United States", admin1: "Illinois" },
        { name: "Springfield", displayName: "Springfield, Missouri", country: "United States", admin1: "Missouri" },
      ],
      message: "Which Springfield do you mean? Please specify a state or country.",
      summary: "Location 'Springfield' is ambiguous. Please specify a state or country.",
    };
    expect(clarification.status).toBe("needs_clarification");
    expect(clarification.candidates.length).toBeLessThanOrEqual(5);
    expect(clarification.summary).toBeTruthy();
  });

  it("should produce not_found with correct error code (Task 4.5)", () => {
    const notFound: WeatherNotFoundResult = {
      schemaVersion: "1.0",
      tool: "current_weather",
      status: "not_found",
      requestedLocation: { raw: "Xyzzy", location: "xyzzy" },
      code: "weather_location_not_found",
      message: "Could not find location 'Xyzzy'.",
      summary: "Could not find 'Xyzzy'. Please provide a more specific location.",
    };
    expect(notFound.status).toBe("not_found");
    expect(notFound.code).toBe("weather_location_not_found");
    expect(notFound.summary).toBeTruthy();
  });

  it("should produce error with stable error codes (Task 4.6, 4.7)", () => {
    const codes = [
      "weather_invalid_input",
      "weather_geocoding_provider_error",
      "weather_forecast_provider_error",
      "weather_timeout",
      "weather_cancelled",
      "weather_unknown_error",
    ] as const;

    for (const code of codes) {
      const error: WeatherErrorResult = {
        schemaVersion: "1.0",
        tool: "current_weather",
        status: "error",
        requestedLocation: { raw: "Tokyo", location: "Tokyo" },
        code,
        retryable: false,
        message: `Error: ${code}`,
        summary: `Weather lookup failed: ${code}.`,
      };
      expect(error.code).toBe(code);
      expect(error.summary).toBeTruthy();
    }
  });

  it("should mark geocoding timeout as retryable (Task 4.11)", () => {
    const error: WeatherErrorResult = {
      schemaVersion: "1.0",
      tool: "current_weather",
      status: "error",
      requestedLocation: { raw: "Tokyo", location: "Tokyo" },
      code: "weather_geocoding_provider_error",
      retryable: true,
      message: "Geocoding provider timed out.",
      summary: "Weather service temporarily unavailable. Please try again.",
    };
    expect(error.retryable).toBe(true);
  });

  it("should mark invalid input as not retryable (Task 4.12)", () => {
    const error: WeatherErrorResult = {
      schemaVersion: "1.0",
      tool: "current_weather",
      status: "error",
      requestedLocation: { raw: "", location: "" },
      code: "weather_invalid_input",
      retryable: false,
      message: "Invalid location input.",
      summary: "Please provide a valid location.",
    };
    expect(error.retryable).toBe(false);
  });

  it("accepts optional queryName without changing WeatherToolResult schemaVersion", async () => {
    const fetchSpy = vi.fn((input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      if (url.hostname !== "geocoding-api.open-meteo.com") {
        throw new Error(`Unexpected network call: ${url.toString()}`);
      }
      return Promise.resolve(jsonResponse({ results: [] }));
    });
    vi.stubGlobal("fetch", fetchSpy);

    const raw = await weatherTool.invoke({
      location: "Definitely Missing Place",
      queryName: "Definitely Missing Place",
    });
    const result = JSON.parse(String(raw)) as WeatherToolResult;

    expect(result.schemaVersion).toBe("1.0");
    expect(result.status).toBe("not_found");
    expect(fetchSpy).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("queryName");
  });

  it("uses an internal resolvedCandidate without repeating geocoding", async () => {
    const fetchSpy = vi.fn((input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname === "geocoding-api.open-meteo.com") {
        throw new Error("geocoding should not be called for resolvedCandidate");
      }
      if (url.hostname === "api.open-meteo.com") {
        return Promise.resolve(jsonResponse({
          latitude: 37.209,
          longitude: -93.2923,
          timezone: "America/Chicago",
          current: {
            time: "2026-06-25T12:00",
            temperature_2m: 22,
            weather_code: 1,
          },
          current_units: {
            temperature_2m: "\u00b0C",
          },
        }));
      }
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const raw = await weatherTool.invoke({
      location: "Springfield, Missouri, United States",
      resolvedCandidate: {
        provider: "open-meteo",
        providerId: "geo-2",
        name: "Springfield",
        displayName: "Springfield, Missouri, United States",
        country: "United States",
        countryCode: "US",
        admin1: "Missouri",
        latitude: 37.209,
        longitude: -93.2923,
        timezone: "America/Chicago",
      },
    });
    const result = JSON.parse(String(raw)) as WeatherToolResult;

    expect(result.status).toBe("success");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    if (result.status === "success" && result.tool === "current_weather") {
      expect(result.resolvedLocation.providerId).toBe("geo-2");
      expect(result.current.temperature).toBe(22);
    }
  });

  it("does not retry after the governance deadline aborts during backoff", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ reason: "temporary failure" }, { status: 503, statusText: "Unavailable" })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(new Error("[governance_timeout] current_weather")),
      10
    );

    try {
      await expect(weatherTool.invoke(
        {
          location: "London",
          resolvedCandidate: {
            provider: "open-meteo",
            name: "London",
            displayName: "London, England, United Kingdom",
            country: "United Kingdom",
            admin1: "England",
            latitude: 51.5085,
            longitude: -0.1257,
            timezone: "Europe/London",
          },
        },
        { signal: controller.signal }
      )).rejects.toThrow("[governance_timeout] current_weather");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it("rejects queryName that exceeds the configured location length", async () => {
    const originalMaxChars = process.env.WEATHER_LOCATION_MAX_CHARS;
    process.env.WEATHER_LOCATION_MAX_CHARS = "5";

    try {
      const raw = await weatherTool.invoke({
        location: "Tokyo",
        queryName: "Taipei",
      });
      const result = JSON.parse(String(raw)) as WeatherToolResult;

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.code).toBe("weather_invalid_input");
        expect(result.retryable).toBe(false);
      }
    } finally {
      if (originalMaxChars === undefined) {
        delete process.env.WEATHER_LOCATION_MAX_CHARS;
      } else {
        process.env.WEATHER_LOCATION_MAX_CHARS = originalMaxChars;
      }
    }
  });
});

describe("weather_forecast tool contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns schemaVersion 1.1 daily forecast entries", async () => {
    installForecastFetchMock();

    const result = await invokeForecast({
      location: "\u53f0\u5317",
      queryName: "Taipei",
      weatherCapability: "daily",
      timeRange: { kind: "tomorrow", startDate: "2026-06-24", endDate: "2026-06-24", granularity: "daily" },
      units: "metric",
      locale: "zh-TW",
    });

    expect(result.schemaVersion).toBe("1.1");
    expect(result.tool).toBe("weather_forecast");
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.weatherCapability).toBe("daily");
      expect(result.daily?.[0]).toMatchObject({
        date: "2026-06-24",
        temperatureMax: 31,
        temperatureMin: 25,
        precipitationProbabilityMax: 80,
        conditionText: "rain",
      });
      expect(JSON.stringify(result)).not.toContain("queryName");
    }
  });

  it("returns schemaVersion 1.1 hourly forecast entries", async () => {
    installForecastFetchMock();

    const result = await invokeForecast({
      location: "Taipei",
      weatherCapability: "hourly",
      timeRange: { kind: "tonight", startDate: "2026-06-23", endDate: "2026-06-24", granularity: "hourly" },
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.weatherCapability).toBe("hourly");
      expect(result.hourly?.[1]).toMatchObject({
        time: "2026-06-23T21:00",
        temperature: 25,
        precipitationProbability: 70,
        conditionText: "rain",
      });
    }
  });

  it("rejects invalid time ranges before provider forecast calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await invokeForecast({
      location: "Taipei",
      weatherCapability: "daily",
      timeRange: { kind: "tomorrow", startDate: "not-a-date" },
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.code).toBe("weather_invalid_input");
      expect(result.retryable).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps not_found and ambiguity distinct", async () => {
    installForecastFetchMock();
    const notFound = await invokeForecast({
      location: "Missing Place",
      weatherCapability: "daily",
      timeRange: { kind: "tomorrow" },
    });
    const ambiguous = await invokeForecast({
      location: "Springfield",
      weatherCapability: "daily",
      timeRange: { kind: "tomorrow" },
    });

    expect(notFound.status).toBe("not_found");
    expect(ambiguous.status).toBe("needs_clarification");
  });

  it("keeps geocoding provider error, forecast provider error, timeout, and cancellation distinct", async () => {
    installForecastFetchMock("geocoding_error");
    const geocodingError = await invokeForecast({
      location: "Taipei",
      weatherCapability: "daily",
      timeRange: { kind: "tomorrow" },
    });

    vi.unstubAllGlobals();
    installForecastFetchMock("forecast_error");
    const forecastError = await invokeForecast({
      location: "Taipei",
      weatherCapability: "daily",
      timeRange: { kind: "tomorrow" },
    });

    vi.unstubAllGlobals();
    vi.stubEnv("WEATHER_GEOCODING_TIMEOUT_MS", "1");
    installForecastFetchMock("timeout");
    const timeout = await invokeForecast({
      location: "Taipei",
      weatherCapability: "daily",
      timeRange: { kind: "tomorrow" },
    });

    vi.unstubAllGlobals();
    installForecastFetchMock();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await invokeForecast({
      location: "Taipei",
      weatherCapability: "daily",
      timeRange: { kind: "tomorrow" },
    }, controller.signal);

    expect(geocodingError.status === "error" && geocodingError.code).toBe("weather_geocoding_provider_error");
    expect(forecastError.status === "error" && forecastError.code).toBe("weather_forecast_provider_error");
    expect(timeout.status === "error" && timeout.code).toBe("weather_timeout");
    expect(cancelled.status === "error" && cancelled.code).toBe("weather_cancelled");
  });
});

describe("Weather env config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should read configurable weather resolver settings from env", () => {
    process.env.WEATHER_LOCATION_MAX_CHARS = "12";
    process.env.WEATHER_GEOCODING_MAX_QUERIES = "4";
    process.env.WEATHER_GEOCODING_MAX_CANDIDATES = "8";
    process.env.WEATHER_GEOCODING_MIN_SCORE = "55";
    process.env.WEATHER_GEOCODING_AMBIGUITY_DELTA = "3";
    process.env.WEATHER_GEOCODING_TIMEOUT_MS = "1234";
    process.env.WEATHER_FORECAST_TIMEOUT_MS = "2345";
    process.env.WEATHER_STRUCTURED_RESULT_ENABLED = "false";

    expect(getWeatherConfig()).toEqual({
      structuredResultEnabled: false,
      locationMaxChars: 12,
      geocodingMaxQueries: 4,
      geocodingMaxCandidates: 8,
      geocodingMinScore: 55,
      geocodingAmbiguityDelta: 3,
      geocodingTimeoutMs: 1234,
      forecastTimeoutMs: 2345,
      forceGeocodingError: false,
      forceForecastError: false,
    });
  });

  it("should fall back when numeric env values are invalid", () => {
    process.env.WEATHER_GEOCODING_MIN_SCORE = "not-a-number";
    process.env.WEATHER_GEOCODING_AMBIGUITY_DELTA = "-1";

    const config = getWeatherConfig();
    expect(config.geocodingMinScore).toBe(35);
    expect(config.geocodingAmbiguityDelta).toBe(8);
  });
});
