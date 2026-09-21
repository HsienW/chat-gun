import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import {
  createErrorEnvelope,
  parseErrorEnvelope,
  serializeErrorEnvelope,
} from "../platform/errors.js";
import { auditLogger, recordMetric } from "../platform/observability.js";
import { configureNetwork } from "../platform/network.js";

import { OpenMeteoGeocodingProvider } from "./geocoding/open-meteo-provider.js";
import { resolveLocation, DEFAULT_RESOLVER_OPTIONS } from "./geocoding/location-resolver.js";
import { buildLocationQuery, normalizeLocation, validateLocationInput } from "./geocoding/location-normalizer.js";
import type {
  LocationCandidate,
  LocationQuery,
  ResolutionStrategy,
  WeatherCapability,
  WeatherForecastResult,
  WeatherForecastSuccessResult,
  WeatherTimeRange,
  WeatherTimeRangeKind,
  WeatherToolResult,
} from "./weather-types.js";

configureNetwork();

type ForecastResponse = {
  latitude: number;
  longitude: number;
  timezone: string;
  current?: Record<string, number | string>;
  current_units?: Record<string, string>;
};

type ForecastProviderResponse = {
  latitude: number;
  longitude: number;
  timezone: string;
  generationtime_ms?: number;
  daily?: Record<string, unknown>;
  daily_units?: Record<string, string>;
  hourly?: Record<string, unknown>;
  hourly_units?: Record<string, string>;
};

type WeatherConfig = {
  structuredResultEnabled: boolean;
  locationMaxChars: number;
  geocodingMaxQueries: number;
  geocodingMaxCandidates: number;
  geocodingMinScore: number;
  geocodingAmbiguityDelta: number;
  geocodingTimeoutMs: number;
  forecastTimeoutMs: number;
  forceGeocodingError: boolean;
  forceForecastError: boolean;
};

function readPositiveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isProductionRuntime(): boolean {
  const values = [process.env.NODE_ENV, process.env.APP_ENV].filter(Boolean);
  return values.some((value) => /^(production|prod)$/i.test(String(value)));
}

function readNonProductionBooleanEnv(name: string): boolean {
  return !isProductionRuntime() && (process.env[name] ?? "").toLowerCase() === "true";
}

export function getWeatherConfig(): WeatherConfig {
  return {
    structuredResultEnabled: (process.env.WEATHER_STRUCTURED_RESULT_ENABLED ?? "true") === "true",
    locationMaxChars: readPositiveNumberEnv("WEATHER_LOCATION_MAX_CHARS", 160),
    geocodingMaxQueries: readPositiveNumberEnv("WEATHER_GEOCODING_MAX_QUERIES", 6),
    geocodingMaxCandidates: readPositiveNumberEnv("WEATHER_GEOCODING_MAX_CANDIDATES", 10),
    geocodingMinScore: readPositiveNumberEnv("WEATHER_GEOCODING_MIN_SCORE", 35),
    geocodingAmbiguityDelta: readPositiveNumberEnv("WEATHER_GEOCODING_AMBIGUITY_DELTA", 8),
    geocodingTimeoutMs: readPositiveNumberEnv("WEATHER_GEOCODING_TIMEOUT_MS", 5_000),
    forecastTimeoutMs: readPositiveNumberEnv("WEATHER_FORECAST_TIMEOUT_MS", 8_000),
    forceGeocodingError: readNonProductionBooleanEnv("WEATHER_TEST_FORCE_GEOCODING_ERROR"),
    forceForecastError: readNonProductionBooleanEnv("WEATHER_TEST_FORCE_FORECAST_ERROR"),
  };
}

function getRunnableSignal(config: RunnableConfig | undefined): AbortSignal | undefined {
  const maybeSignal = config?.signal;
  return maybeSignal instanceof AbortSignal ? maybeSignal : undefined;
}

function isCancelError(message: string): boolean {
  return message === "weather_fetch_cancelled" || message === "weather_geocoding_cancelled";
}

function isTimeoutError(message: string): boolean {
  return message === "weather_fetch_timeout" || message === "weather_geocoding_timeout" || message.includes("timeout");
}

function getFetchAbortError(signal: AbortSignal | undefined): Error {
  const reasonMessage =
    signal?.reason instanceof Error
      ? signal.reason.message
      : typeof signal?.reason === "string"
        ? signal.reason
        : "";

  return new Error(
    reasonMessage.includes("[governance_timeout]")
      ? "weather_governance_timeout"
      : "weather_fetch_cancelled"
  );
}

function validateOptionalQueryName(
  rawQueryName: unknown,
  maxChars: number
): { queryName?: string; error?: string } {
  if (rawQueryName === undefined) {
    return {};
  }

  if (typeof rawQueryName !== "string") {
    return { error: "queryName must be a string when provided." };
  }

  const validationError = validateLocationInput(rawQueryName, maxChars);
  if (validationError) {
    return { error: validationError.replace("Location input", "queryName") };
  }

  return { queryName: normalizeLocation(rawQueryName) };
}

const resolvedCandidateSchema = z.object({
  provider: z.literal("open-meteo").optional(),
  providerId: z.string().optional(),
  name: z.string().min(1),
  displayName: z.string().min(1),
  country: z.string().optional(),
  countryCode: z.string().optional(),
  admin1: z.string().optional(),
  admin2: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string().optional(),
  population: z.number().optional(),
});

function coerceResolvedCandidate(value: unknown): LocationCandidate | undefined {
  const parsed = resolvedCandidateSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return {
    provider: "open-meteo",
    ...parsed.data,
  };
}

function toClarificationCandidate(candidate: LocationCandidate) {
  return {
    name: candidate.name,
    displayName: candidate.displayName,
    country: candidate.country,
    countryCode: candidate.countryCode,
    admin1: candidate.admin1,
    admin2: candidate.admin2,
    providerId: candidate.providerId,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    timezone: candidate.timezone,
  };
}

export function describeWeatherCode(code: number | undefined): string {
  switch (code) {
    case 0:
      return "clear sky";
    case 1:
    case 2:
    case 3:
      return "mainly clear, partly cloudy, or overcast";
    case 45:
    case 48:
      return "fog";
    case 51:
    case 53:
    case 55:
      return "drizzle";
    case 56:
    case 57:
      return "freezing drizzle";
    case 61:
    case 63:
    case 65:
      return "rain";
    case 66:
    case 67:
      return "freezing rain";
    case 71:
    case 73:
    case 75:
      return "snowfall";
    case 77:
      return "snow grains";
    case 80:
    case 81:
    case 82:
      return "rain showers";
    case 85:
    case 86:
      return "snow showers";
    case 95:
      return "thunderstorm";
    case 96:
    case 99:
      return "thunderstorm with hail";
    default:
      return "unknown weather condition";
  }
}

export function describeWindDirection(degrees: number | undefined): string {
  if (degrees === undefined || Number.isNaN(degrees)) {
    return "unknown";
  }

  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return directions[index];
}

/**
 * Fetch JSON with real AbortSignal support — Task 4.10
 * Uses AbortController with timeout, not just Promise.race.
 */
async function fetchJsonWithTimeout<T>(url: URL, timeoutMs: number, externalSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const forwardExternalAbort = () => controller.abort(externalSignal?.reason);

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      throw getFetchAbortError(externalSignal);
    }
    externalSignal.addEventListener("abort", forwardExternalAbort, {
      once: true,
    });
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "chat-gun/0.1",
      },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (externalSignal?.aborted) {
        throw getFetchAbortError(externalSignal);
      }
      throw new Error("weather_fetch_timeout");
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("fetch failed") || message.includes("aborted")) {
      // Proxy hint goes only to audit log, NOT to user-facing error message — M2 fix
      const proxyConfigured = Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
      if (proxyConfigured) {
        console.warn("[weather] Proxy configured but request failed for", url.hostname);
      }
      throw new Error(
        `Weather provider network request failed for ${url.hostname}.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", forwardExternalAbort);
  }
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw getFetchAbortError(signal);
  }

  await new Promise<void>((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timeoutId);
      reject(getFetchAbortError(signal));
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

/**
 * Retry a fetch once for temporary errors — Task 4.11, 4.12
 */
async function fetchWithRetry<T>(url: URL, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const maxAttempts = 2; // Initial + 1 retry
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw getFetchAbortError(signal);
    }

    try {
      return await fetchJsonWithTimeout<T>(url, timeoutMs, signal);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const message = lastError.message;

      // Only retry temporary/provider errors — Task 4.12
      const isRetryable =
        message.includes("429") ||
        message.includes("502") ||
        message.includes("503") ||
        message.includes("504") ||
        message === "weather_fetch_timeout" ||
        message === "weather_geocoding_timeout" ||
        message.includes("fetch failed") ||
        message.includes("econnrefused") ||
        message.includes("econnreset");

      if (isCancelError(message) || !isRetryable || attempt >= maxAttempts) {
        throw lastError;
      }

      // Bounded backoff: 250ms + jitter
      await waitForRetry(250 + Math.random() * 250, signal);
      await recordMetric("weather.provider.retry", {
        url: url.hostname,
        attempt,
        error: message,
      });
    }
  }

  throw lastError ?? new Error("Retry exhausted");
}

function numberValue(
  current: Record<string, number | string>,
  key: string
): number | undefined {
  const value = current[key];
  return typeof value === "number" ? value : undefined;
}

function formatFallbackText(candidate: LocationCandidate): string {
  return [candidate.name, candidate.admin2, candidate.admin1, candidate.country]
    .filter(Boolean)
    .join(", ");
}

/**
 * Build the structured WeatherToolResult for a successful forecast — Task 4.3, 4.9
 */
function buildSuccessResult(
  query: LocationQuery,
  candidate: LocationCandidate,
  forecast: ForecastResponse,
  sourceUrl: string
): WeatherToolResult {
  const current = forecast.current ?? {};
  const units = forecast.current_units ?? {};
  const weatherCode = numberValue(current, "weather_code");
  const windDirection = numberValue(current, "wind_direction_10m");
  const displayName = formatFallbackText(candidate);

  return {
    schemaVersion: "1.0",
    tool: "current_weather",
    status: "success",
    requestedLocation: query,
    resolvedLocation: candidate,
    observedAt: String(current.time ?? ""),
    timezone: forecast.timezone,
    current: {
      conditionCode: weatherCode,
      conditionText: describeWeatherCode(weatherCode),
      temperature: numberValue(current, "temperature_2m"),
      apparentTemperature: numberValue(current, "apparent_temperature"),
      relativeHumidity: numberValue(current, "relative_humidity_2m"),
      precipitation: numberValue(current, "precipitation"),
      rain: numberValue(current, "rain"),
      cloudCover: numberValue(current, "cloud_cover"),
      pressureMsl: numberValue(current, "pressure_msl"),
      windSpeed: numberValue(current, "wind_speed_10m"),
      windDirectionDegrees: windDirection,
      windDirectionText: describeWindDirection(windDirection),
      windGusts: numberValue(current, "wind_gusts_10m"),
    },
    units: units as Record<string, string>,
    provider: "Open-Meteo",
    sourceUrl,
    summary: [
      `Current weather for ${displayName}: ${current.temperature_2m ?? "?"}${units.temperature_2m ?? ""}, ${describeWeatherCode(weatherCode)}.`,
      `Observed at ${String(current.time ?? "")}.`,
    ].join(" "),
  };
}

const FORECAST_CAPABILITIES = ["hourly", "daily"] as const;
const FORECAST_TIME_RANGE_KINDS = [
  "today",
  "tonight",
  "tomorrow",
  "weekend",
  "date_range",
] as const;

function isForecastCapability(value: unknown): value is Exclude<WeatherCapability, "current"> {
  return FORECAST_CAPABILITIES.includes(value as Exclude<WeatherCapability, "current">);
}

function isForecastTimeRangeKind(value: unknown): value is Exclude<WeatherTimeRangeKind, "now"> {
  return FORECAST_TIME_RANGE_KINDS.includes(value as Exclude<WeatherTimeRangeKind, "now">);
}

function isIsoDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateForecastTimeRange(rawTimeRange: unknown): { timeRange?: WeatherTimeRange; error?: string } {
  if (!rawTimeRange || typeof rawTimeRange !== "object" || Array.isArray(rawTimeRange)) {
    return { error: "timeRange must be an object for forecast requests." };
  }

  const value = rawTimeRange as Record<string, unknown>;
  if (!isForecastTimeRangeKind(value.kind)) {
    return { error: "timeRange.kind must be today, tonight, tomorrow, weekend, or date_range." };
  }

  const startDate = typeof value.startDate === "string" ? value.startDate : undefined;
  const endDate = typeof value.endDate === "string" ? value.endDate : undefined;
  if (startDate && !isIsoDateString(startDate)) {
    return { error: "timeRange.startDate must be an ISO date string." };
  }
  if (endDate && !isIsoDateString(endDate)) {
    return { error: "timeRange.endDate must be an ISO date string." };
  }
  if (startDate && endDate && startDate > endDate) {
    return { error: "timeRange.startDate must be before or equal to endDate." };
  }

  const timezone = typeof value.timezone === "string" && value.timezone.trim()
    ? value.timezone.trim()
    : undefined;
  const granularity =
    value.granularity === "hourly" || value.granularity === "daily"
      ? value.granularity
      : undefined;

  return {
    timeRange: {
      kind: value.kind,
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(timezone ? { timezone } : {}),
      ...(granularity ? { granularity } : {}),
    },
  };
}

function numberArray(section: Record<string, unknown>, key: string): number[] | undefined {
  const value = section[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "number")
    ? value
    : undefined;
}

function stringArray(section: Record<string, unknown>, key: string): string[] | undefined {
  const value = section[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function buildDailyForecastEntries(daily: Record<string, unknown>): WeatherForecastSuccessResult["daily"] | undefined {
  const dates = stringArray(daily, "time");
  if (!dates?.length) {
    return undefined;
  }

  const weatherCodes = numberArray(daily, "weather_code");
  const temperatureMax = numberArray(daily, "temperature_2m_max");
  const temperatureMin = numberArray(daily, "temperature_2m_min");
  const precipitationProbabilityMax = numberArray(daily, "precipitation_probability_max");
  const precipitationSum = numberArray(daily, "precipitation_sum");

  return dates.map((date, index) => {
    const conditionCode = weatherCodes?.[index];
    return {
      date,
      conditionCode,
      conditionText: describeWeatherCode(conditionCode),
      temperatureMax: temperatureMax?.[index],
      temperatureMin: temperatureMin?.[index],
      precipitationProbabilityMax: precipitationProbabilityMax?.[index],
      precipitationSum: precipitationSum?.[index],
    };
  });
}

function buildHourlyForecastEntries(hourly: Record<string, unknown>): WeatherForecastSuccessResult["hourly"] | undefined {
  const times = stringArray(hourly, "time");
  if (!times?.length) {
    return undefined;
  }

  const weatherCodes = numberArray(hourly, "weather_code");
  const temperature = numberArray(hourly, "temperature_2m");
  const precipitationProbability = numberArray(hourly, "precipitation_probability");
  const precipitation = numberArray(hourly, "precipitation");

  return times.map((time, index) => {
    const conditionCode = weatherCodes?.[index];
    return {
      time,
      conditionCode,
      conditionText: describeWeatherCode(conditionCode),
      temperature: temperature?.[index],
      precipitationProbability: precipitationProbability?.[index],
      precipitation: precipitation?.[index],
    };
  });
}

function buildForecastSourceUrl(
  place: LocationCandidate,
  weatherCapability: Exclude<WeatherCapability, "current">,
  timeRange: WeatherTimeRange
): URL {
  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(place.latitude));
  forecastUrl.searchParams.set("longitude", String(place.longitude));
  forecastUrl.searchParams.set("timezone", timeRange.timezone ?? place.timezone ?? "auto");

  if (timeRange.startDate) {
    forecastUrl.searchParams.set("start_date", timeRange.startDate);
  }
  if (timeRange.endDate) {
    forecastUrl.searchParams.set("end_date", timeRange.endDate);
  }
  if (!timeRange.startDate && !timeRange.endDate) {
    const forecastDaysByKind: Record<WeatherTimeRangeKind, string> = {
      now: "1",
      today: "1",
      tonight: "2",
      tomorrow: "2",
      weekend: "7",
      date_range: "7",
    };
    forecastUrl.searchParams.set("forecast_days", forecastDaysByKind[timeRange.kind]);
  }

  if (weatherCapability === "daily") {
    forecastUrl.searchParams.set(
      "daily",
      [
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "precipitation_sum",
      ].join(",")
    );
  } else {
    forecastUrl.searchParams.set(
      "hourly",
      [
        "temperature_2m",
        "precipitation_probability",
        "precipitation",
        "weather_code",
      ].join(",")
    );
  }

  return forecastUrl;
}

function buildForecastSuccessResult(
  query: LocationQuery,
  candidate: LocationCandidate,
  forecast: ForecastProviderResponse,
  weatherCapability: Exclude<WeatherCapability, "current">,
  timeRange: WeatherTimeRange,
  sourceUrl: string
): WeatherForecastSuccessResult | undefined {
  const daily = forecast.daily && typeof forecast.daily === "object" && !Array.isArray(forecast.daily)
    ? buildDailyForecastEntries(forecast.daily as Record<string, unknown>)
    : undefined;
  const hourly = forecast.hourly && typeof forecast.hourly === "object" && !Array.isArray(forecast.hourly)
    ? buildHourlyForecastEntries(forecast.hourly as Record<string, unknown>)
    : undefined;

  if (weatherCapability === "daily" && !daily?.length) {
    return undefined;
  }
  if (weatherCapability === "hourly" && !hourly?.length) {
    return undefined;
  }

  const displayName = formatFallbackText(candidate);
  const firstDaily = daily?.[0];
  const firstHourly = hourly?.[0];
  const summary = weatherCapability === "daily"
    ? `Daily forecast for ${displayName}: ${firstDaily?.temperatureMin ?? "?"}-${firstDaily?.temperatureMax ?? "?"}${forecast.daily_units?.temperature_2m_max ?? ""}, ${firstDaily?.conditionText ?? "unknown weather condition"}.`
    : `Hourly forecast for ${displayName}: ${firstHourly?.temperature ?? "?"}${forecast.hourly_units?.temperature_2m ?? ""}, ${firstHourly?.conditionText ?? "unknown weather condition"}.`;

  return {
    schemaVersion: "1.1",
    tool: "weather_forecast",
    status: "success",
    requestedLocation: query,
    resolvedLocation: candidate,
    weatherCapability,
    timeRange,
    generatedAt: new Date().toISOString(),
    timezone: forecast.timezone,
    ...(daily?.length ? { daily } : {}),
    ...(hourly?.length ? { hourly } : {}),
    units: {
      ...(forecast.daily_units ?? {}),
      ...(forecast.hourly_units ?? {}),
    },
    provider: "Open-Meteo",
    sourceUrl,
    summary,
  };
}

function createForecastInvalidInputResult(
  location: unknown,
  message: string
): WeatherForecastResult {
  const locationText = typeof location === "string" ? location : "";
  return {
    schemaVersion: "1.1",
    tool: "weather_forecast",
    status: "error",
    requestedLocation: { raw: locationText, location: locationText },
    code: "weather_invalid_input",
    retryable: false,
    message,
    summary: "Invalid forecast input. Please provide a valid location and forecast time range.",
  };
}

/**
 * Build a legacy text output from structured result — for backward compatibility
 * during the WEATHER_STRUCTURED_RESULT_ENABLED transition period.
 */
function formatLegacyText(result: WeatherToolResult): string {
  if (result.status === "success" && result.tool === "current_weather") {
    const { current, resolvedLocation } = result;
    const displayName = formatFallbackText(resolvedLocation);
    const lines = [
      "Provider: Open-Meteo current weather API",
      "Data scope: latest current weather observation, not a full-day forecast.",
      `Resolved location: ${displayName} (${resolvedLocation.latitude}, ${resolvedLocation.longitude})`,
      `Observation time: ${result.observedAt}, timezone: ${result.timezone}`,
      `Condition: ${current.conditionText} (code ${current.conditionCode ?? "unknown"})`,
      `Temperature: ${current.temperature ?? "?"}${result.units.temperature_2m ?? ""}`,
    ];
    if (current.apparentTemperature !== undefined) {
      lines.push(`Feels like: ${current.apparentTemperature}${result.units.apparent_temperature ?? ""}`);
    }
    if (current.relativeHumidity !== undefined) {
      lines.push(`Humidity: ${current.relativeHumidity}${result.units.relative_humidity_2m ?? ""}`);
    }
    if (current.precipitation !== undefined) {
      lines.push(`Precipitation: ${current.precipitation}${result.units.precipitation ?? ""}`);
    }
    if (current.rain !== undefined) {
      lines.push(`Rain: ${current.rain}${result.units.rain ?? ""}`);
    }
    if (current.cloudCover !== undefined) {
      lines.push(`Cloud cover: ${current.cloudCover}${result.units.cloud_cover ?? ""}`);
    }
    lines.push(`Wind: ${current.windSpeed ?? "?"}${result.units.wind_speed_10m ?? ""}, direction ${current.windDirectionText} (${current.windDirectionDegrees ?? "unknown"}${result.units.wind_direction_10m ?? ""})`);
    if (current.windGusts !== undefined) {
      lines.push(`Wind gusts: ${current.windGusts}${result.units.wind_gusts_10m ?? ""}`);
    }
    if (current.pressureMsl !== undefined) {
      lines.push(`Pressure: ${current.pressureMsl}${result.units.pressure_msl ?? ""}`);
    }
    lines.push(`Source URL: ${result.sourceUrl}`);
    return lines.join("\n");
  }

  if (result.status === "needs_clarification") {
    return result.summary;
  }

  if (result.status === "not_found") {
    return result.summary;
  }

  // error
  return result.summary;
}

export const weatherForecastTool = tool(
  async (
    {
      location,
      country,
      region,
      queryName,
      resolutionStrategy,
      raw,
      weatherCapability,
      timeRange,
      resolvedCandidate,
    },
    config?: RunnableConfig
  ) => {
    const startTime = Date.now();
    const weatherConfig = getWeatherConfig();
    const runSignal = getRunnableSignal(config);
    const geocodingProvider = new OpenMeteoGeocodingProvider(weatherConfig.geocodingTimeoutMs);
    const strategy: ResolutionStrategy | undefined =
      resolutionStrategy === "llm_repair" ? "llm_repair" : undefined;

    const validationError = validateLocationInput(location, weatherConfig.locationMaxChars);
    if (validationError) {
      return JSON.stringify(createForecastInvalidInputResult(location, validationError));
    }

    if (!isForecastCapability(weatherCapability)) {
      return JSON.stringify(
        createForecastInvalidInputResult(
          location,
          "weatherCapability must be hourly or daily for weather_forecast."
        )
      );
    }

    const timeRangeValidation = validateForecastTimeRange(timeRange);
    if (timeRangeValidation.error || !timeRangeValidation.timeRange) {
      return JSON.stringify(
        createForecastInvalidInputResult(
          location,
          timeRangeValidation.error ?? "timeRange is required for forecast requests."
        )
      );
    }

    const queryNameValidation = validateOptionalQueryName(
      queryName,
      weatherConfig.locationMaxChars
    );
    if (queryNameValidation.error) {
      return JSON.stringify(createForecastInvalidInputResult(location, queryNameValidation.error));
    }

    const query = {
      ...buildLocationQuery(location, country, region),
      raw: typeof raw === "string" && raw.trim() ? raw : location,
    };
    const directCandidate = coerceResolvedCandidate(resolvedCandidate);
    const providerQueryName = queryNameValidation.queryName;
    await auditLogger.record("weather.forecast.location.resolve.start", {
      raw: query.raw,
      location: query.location,
      country: query.country,
      capability: weatherCapability,
      timeRangeKind: timeRangeValidation.timeRange.kind,
      queryNameProvided: Boolean(providerQueryName),
      directCandidateProvided: Boolean(directCandidate),
    });

    if (weatherConfig.forceGeocodingError) {
      const result: WeatherForecastResult = {
        schemaVersion: "1.1",
        tool: "weather_forecast",
        status: "error",
        requestedLocation: query,
        code: "weather_geocoding_provider_error",
        retryable: true,
        message: "Forced geocoding provider error for non-production manual verification.",
        summary: "Weather geocoding service is temporarily unavailable.",
      };
      return JSON.stringify(result);
    }

    let resolutionResult;
    try {
      resolutionResult = directCandidate
        ? {
            status: "resolved" as const,
            query,
            candidate: directCandidate,
            confidence: 100,
            strategy: "contextual" as const,
            attemptedQueries: [],
          }
        : await resolveLocation(query, geocodingProvider, {
            ...DEFAULT_RESOLVER_OPTIONS,
            minScore: weatherConfig.geocodingMinScore,
            ambiguityDelta: weatherConfig.geocodingAmbiguityDelta,
            maxCandidates: weatherConfig.geocodingMaxCandidates,
            maxQueries: weatherConfig.geocodingMaxQueries,
            signal: runSignal,
            strategy,
            queryName: providerQueryName,
          });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const result: WeatherForecastResult = {
        schemaVersion: "1.1",
        tool: "weather_forecast",
        status: "error",
        requestedLocation: query,
        code: isCancelError(errorMessage)
          ? "weather_cancelled"
          : isTimeoutError(errorMessage)
            ? "weather_timeout"
            : "weather_geocoding_provider_error",
        retryable: !isCancelError(errorMessage) && isTimeoutError(errorMessage),
        message: errorMessage,
        summary: isCancelError(errorMessage)
          ? "Weather forecast lookup was cancelled."
          : "Weather geocoding service is temporarily unavailable.",
      };
      return JSON.stringify(result);
    }

    if (resolutionResult.status === "ambiguous") {
      const candidates = resolutionResult.candidates.slice(0, 5).map(toClarificationCandidate);
      const result: WeatherForecastResult = {
        schemaVersion: "1.1",
        tool: "weather_forecast",
        status: "needs_clarification",
        requestedLocation: query,
        candidates,
        message: `Location "${query.location}" is ambiguous. Please provide a more specific location with country or region.`,
        summary: `Location "${query.location}" matches multiple candidates. Please specify a country or region.`,
      };
      return JSON.stringify(result);
    }

    if (resolutionResult.status === "not_found") {
      const result: WeatherForecastResult = {
        schemaVersion: "1.1",
        tool: "weather_forecast",
        status: "not_found",
        requestedLocation: query,
        code: "weather_location_not_found",
        message: `Could not find location "${query.location}". Please provide a more specific location.`,
        summary: `Could not find "${query.location}". Please provide a more specific location.`,
        attemptedQueries: resolutionResult.attemptedQueries,
      };
      return JSON.stringify(result);
    }

    if (resolutionResult.status === "provider_error") {
      const result: WeatherForecastResult = {
        schemaVersion: "1.1",
        tool: "weather_forecast",
        status: "error",
        requestedLocation: query,
        code: resolutionResult.code === "weather_geocoding_cancelled"
          ? "weather_cancelled"
          : resolutionResult.code === "weather_geocoding_timeout"
            ? "weather_timeout"
            : "weather_geocoding_provider_error",
        retryable: resolutionResult.retryable,
        message: `Geocoding provider error: ${resolutionResult.code}`,
        summary: resolutionResult.code === "weather_geocoding_cancelled"
          ? "Weather forecast lookup was cancelled."
          : "Weather geocoding service is temporarily unavailable.",
      };
      return JSON.stringify(result);
    }

    if (weatherConfig.forceForecastError) {
      const result: WeatherForecastResult = {
        schemaVersion: "1.1",
        tool: "weather_forecast",
        status: "error",
        requestedLocation: query,
        code: "weather_forecast_provider_error",
        retryable: true,
        message: "Forced forecast provider error for non-production manual verification.",
        summary: "Weather forecast service is temporarily unavailable.",
      };
      return JSON.stringify(result);
    }

    const place = resolutionResult.candidate;
    const forecastUrl = buildForecastSourceUrl(
      place,
      weatherCapability,
      timeRangeValidation.timeRange
    );

    try {
      const forecast = await fetchWithRetry<ForecastProviderResponse>(
        forecastUrl,
        weatherConfig.forecastTimeoutMs,
        runSignal
      );
      const result = buildForecastSuccessResult(
        query,
        place,
        forecast,
        weatherCapability,
        timeRangeValidation.timeRange,
        forecastUrl.toString()
      );

      if (!result) {
        const providerError: WeatherForecastResult = {
          schemaVersion: "1.1",
          tool: "weather_forecast",
          status: "error",
          requestedLocation: query,
          code: "weather_forecast_provider_error",
          retryable: false,
          message: "Open-Meteo did not return valid forecast data.",
          summary: "Weather forecast service did not return data for this request.",
        };
        return JSON.stringify(providerError);
      }

      await recordMetric("weather.provider.forecast.duration_ms", {
        durationMs: Date.now() - startTime,
      });
      await auditLogger.record("weather.forecast.success", {
        raw: query.raw,
        provider: place.provider,
        strategy: resolutionResult.strategy,
        capability: weatherCapability,
        durationMs: Date.now() - startTime,
      });

      return JSON.stringify(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const result: WeatherForecastResult = {
        schemaVersion: "1.1",
        tool: "weather_forecast",
        status: "error",
        requestedLocation: query,
        code: isCancelError(errorMessage)
          ? "weather_cancelled"
          : isTimeoutError(errorMessage)
            ? "weather_timeout"
            : "weather_forecast_provider_error",
        retryable: !isCancelError(errorMessage) && (isTimeoutError(errorMessage) || errorMessage.includes("fetch failed")),
        message: errorMessage,
        summary: isCancelError(errorMessage)
          ? "Weather forecast lookup was cancelled."
          : "Weather forecast service is temporarily unavailable.",
      };
      await recordMetric("weather.provider.forecast.failure.count", { count: 1 });
      return JSON.stringify(result);
    }
  },
  {
    name: "weather_forecast",
    description:
      "Get hourly or daily weather forecast for a city or location using Open-Meteo. Use this for tomorrow, tonight, weekend, date range, rain probability, temperature trend, or other forecast-backed weather questions. Do not use it for historical weather, climate knowledge, or standalone advice.",
    schema: z.object({
      location: z.string().min(1).describe("City or location name."),
      country: z
        .string()
        .optional()
        .describe("Optional country hint, for example 'Taiwan', 'Japan', or 'United States'."),
      region: z
        .string()
        .optional()
        .describe("Optional state, province, or administrative region hint, for example 'New York'."),
      queryName: z
        .string()
        .optional()
        .describe("Optional geocoding-friendly Latin name for Chinese or mixed-Chinese locations."),
      weatherCapability: z
        .enum(["hourly", "daily"])
        .describe("Forecast granularity requested by the planner."),
      timeRange: z.object({
        kind: z.enum(["today", "tonight", "tomorrow", "weekend", "date_range"]),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        timezone: z.string().optional(),
        granularity: z.enum(["hourly", "daily"]).optional(),
      }),
      units: z.enum(["metric"]).optional().describe("Forecast units. Metric is the only Phase 2 unit."),
      locale: z.string().optional().describe("Optional user locale metadata for display/synthesis."),
      resolutionStrategy: z
        .enum(["llm_repair"])
        .optional()
        .describe("Internal marker for one-time LLM repair; callers should normally omit this."),
      raw: z
        .string()
        .optional()
        .describe("Internal original user location text preserved across one-time repair."),
      resolvedCandidate: resolvedCandidateSchema
        .optional()
        .describe("Internal resolved geocoding candidate for checkpoint resume; callers should normally omit this."),
    }),
  }
);

export const weatherTool = tool(
  async ({ location, country, region, queryName, resolutionStrategy, raw, resolvedCandidate }, config?: RunnableConfig) => {
    const startTime = Date.now();
    const weatherConfig = getWeatherConfig();
    const runSignal = getRunnableSignal(config);
    const geocodingProvider = new OpenMeteoGeocodingProvider(weatherConfig.geocodingTimeoutMs);
    const strategy: ResolutionStrategy | undefined =
      resolutionStrategy === "llm_repair" ? "llm_repair" : undefined;

    // Validate input
    const validationError = validateLocationInput(location, weatherConfig.locationMaxChars);
    if (validationError) {
      const result: WeatherToolResult = {
        schemaVersion: "1.0",
        tool: "current_weather",
        status: "error",
        requestedLocation: { raw: location ?? "", location: location ?? "" },
        code: "weather_invalid_input",
        retryable: false,
        message: validationError,
        summary: "Invalid location input. Please provide a valid city or place name.",
      };
      await auditLogger.record("weather.location.resolve.start", {
        error: "invalid_input",
        location,
      });
      return weatherConfig.structuredResultEnabled
        ? JSON.stringify(result)
        : formatLegacyText(result);
    }

    const queryNameValidation = validateOptionalQueryName(
      queryName,
      weatherConfig.locationMaxChars
    );
    if (queryNameValidation.error) {
      const result: WeatherToolResult = {
        schemaVersion: "1.0",
        tool: "current_weather",
        status: "error",
        requestedLocation: { raw: location ?? "", location: location ?? "" },
        code: "weather_invalid_input",
        retryable: false,
        message: queryNameValidation.error,
        summary: "Invalid location input. Please provide a valid city or place name.",
      };
      await auditLogger.record("weather.location.resolve.start", {
        error: "invalid_query_name",
        location,
        queryNameProvided: true,
      });
      return weatherConfig.structuredResultEnabled
        ? JSON.stringify(result)
        : formatLegacyText(result);
    }

    // Build the query
    const query = {
      ...buildLocationQuery(location, country, region),
      raw: typeof raw === "string" && raw.trim() ? raw : location,
    };
    const directCandidate = coerceResolvedCandidate(resolvedCandidate);
    const providerQueryName = queryNameValidation.queryName;
    await auditLogger.record("weather.location.resolve.start", {
      raw: query.raw,
      location: query.location,
      country: query.country,
      queryNameProvided: Boolean(providerQueryName),
      directCandidateProvided: Boolean(directCandidate),
    });

    if (weatherConfig.forceGeocodingError) {
      const result: WeatherToolResult = {
        schemaVersion: "1.0",
        tool: "current_weather",
        status: "error",
        requestedLocation: query,
        code: "weather_geocoding_provider_error",
        retryable: true,
        message: "Forced geocoding provider error for non-production manual verification.",
        summary: "Weather geocoding service is temporarily unavailable.",
      };
      await recordMetric("weather.location.resolve.failure.count", { count: 1 });
      await auditLogger.record("weather.location.resolve.failure", {
        raw: query.raw,
        code: "weather_geocoding_provider_error",
        forced: true,
        durationMs: Date.now() - startTime,
      });
      return weatherConfig.structuredResultEnabled
        ? JSON.stringify(result)
        : formatLegacyText(result);
    }

    // Resolve location through the geocoding pipeline
    let resolutionResult;
    try {
      resolutionResult = directCandidate
        ? {
            status: "resolved" as const,
            query,
            candidate: directCandidate,
            confidence: 100,
            strategy: "contextual" as const,
            attemptedQueries: [],
          }
        : await resolveLocation(query, geocodingProvider, {
            ...DEFAULT_RESOLVER_OPTIONS,
            minScore: weatherConfig.geocodingMinScore,
            ambiguityDelta: weatherConfig.geocodingAmbiguityDelta,
            maxCandidates: weatherConfig.geocodingMaxCandidates,
            maxQueries: weatherConfig.geocodingMaxQueries,
            signal: runSignal,
            strategy,
            queryName: providerQueryName,
          });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const result: WeatherToolResult = {
        schemaVersion: "1.0",
        tool: "current_weather",
        status: "error",
        requestedLocation: query,
        code: isCancelError(errorMessage)
          ? "weather_cancelled"
          : isTimeoutError(errorMessage)
            ? "weather_timeout"
            : "weather_geocoding_provider_error",
        retryable: !isCancelError(errorMessage) && isTimeoutError(errorMessage),
        message: errorMessage,
        summary: isCancelError(errorMessage)
          ? "Weather lookup was cancelled."
          : "Weather service temporarily unavailable. Please try again.",
      };
      await recordMetric("weather.location.resolve.failure.count", { count: 1 });
      return weatherConfig.structuredResultEnabled
        ? JSON.stringify(result)
        : formatLegacyText(result);
    }

    // Handle non-resolved statuses
    if (resolutionResult.status === "ambiguous") {
      const candidates = resolutionResult.candidates.slice(0, 5).map(toClarificationCandidate);
      const result: WeatherToolResult = {
        schemaVersion: "1.0",
        tool: "current_weather",
        status: "needs_clarification",
        requestedLocation: query,
        candidates,
        message: `Location "${query.location}" is ambiguous. Please provide a more specific location with country or region.`,
        summary: `Location "${query.location}" matches multiple candidates. Please specify a country or region.`,
      };
      await recordMetric("weather.location.resolve.ambiguous.count", { count: 1 });
      await auditLogger.record("weather.location.resolve.ambiguous", {
        raw: query.raw,
        candidateCount: candidates.length,
        durationMs: Date.now() - startTime,
      });
      return weatherConfig.structuredResultEnabled
        ? JSON.stringify(result)
        : `Location "${query.location}" is ambiguous. Candidates: ${candidates.map((c) => c.displayName).join("; ")}`;
    }

    if (resolutionResult.status === "not_found") {
      const result: WeatherToolResult = {
        schemaVersion: "1.0",
        tool: "current_weather",
        status: "not_found",
        requestedLocation: query,
        code: "weather_location_not_found",
        message: `Could not find location "${query.location}". Please provide a more specific location.`,
        summary: `Could not find "${query.location}". Please provide a more specific location.`,
        attemptedQueries: resolutionResult.attemptedQueries,
      };
      await recordMetric("weather.location.resolve.not_found.count", { count: 1 });
      await auditLogger.record("weather.location.resolve.not_found", {
        raw: query.raw,
        attemptedQueries: resolutionResult.attemptedQueries,
        durationMs: Date.now() - startTime,
      });
      return weatherConfig.structuredResultEnabled
        ? JSON.stringify(result)
        : `Location not found: ${query.location}. Please provide a more specific location.`;
    }

    if (resolutionResult.status === "provider_error") {
      const result: WeatherToolResult = {
        schemaVersion: "1.0",
        tool: "current_weather",
        status: "error",
        requestedLocation: query,
        code: resolutionResult.code === "weather_geocoding_cancelled"
          ? "weather_cancelled"
          : resolutionResult.code === "weather_geocoding_timeout"
            ? "weather_timeout"
            : "weather_geocoding_provider_error",
        retryable: resolutionResult.retryable,
        message: `Geocoding provider error: ${resolutionResult.code}`,
        summary: resolutionResult.code === "weather_geocoding_cancelled"
          ? "Weather lookup was cancelled."
          : "Weather service temporarily unavailable. Please try again.",
      };
      await recordMetric("weather.location.resolve.failure.count", { count: 1 });
      await auditLogger.record("weather.location.resolve.failure", {
        raw: query.raw,
        code: resolutionResult.code,
        durationMs: Date.now() - startTime,
      });
      return weatherConfig.structuredResultEnabled
        ? JSON.stringify(result)
        : "Weather geocoding service is temporarily unavailable. Please try again later.";
    }

    // Resolved — fetch forecast
    const place = resolutionResult.candidate;
    if (weatherConfig.forceForecastError) {
      const result: WeatherToolResult = {
        schemaVersion: "1.0",
        tool: "current_weather",
        status: "error",
        requestedLocation: query,
        code: "weather_forecast_provider_error",
        retryable: true,
        message: "Forced forecast provider error for non-production manual verification.",
        summary: "Weather forecast service is temporarily unavailable.",
      };
      await recordMetric("weather.provider.forecast.failure.count", { count: 1 });
      await auditLogger.record("weather.provider.forecast.failure", {
        raw: query.raw,
        error: "weather_forecast_provider_error",
        forced: true,
        durationMs: Date.now() - startTime,
      });
      return weatherConfig.structuredResultEnabled
        ? JSON.stringify(result)
        : formatLegacyText(result);
    }

    const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
    forecastUrl.searchParams.set("latitude", String(place.latitude));
    forecastUrl.searchParams.set("longitude", String(place.longitude));
    forecastUrl.searchParams.set(
      "current",
      [
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "is_day",
        "precipitation",
        "rain",
        "weather_code",
        "cloud_cover",
        "pressure_msl",
        "wind_speed_10m",
        "wind_direction_10m",
        "wind_gusts_10m",
      ].join(",")
    );
    forecastUrl.searchParams.set("timezone", place.timezone ?? "auto");

    try {
      const forecast = await fetchWithRetry<ForecastResponse>(
        forecastUrl,
        weatherConfig.forecastTimeoutMs,
        runSignal
      );
      const current = forecast.current;

      if (!current) {
        const result: WeatherToolResult = {
          schemaVersion: "1.0",
          tool: "current_weather",
          status: "error",
          requestedLocation: query,
          code: "weather_forecast_provider_error",
          retryable: false,
          message: "Open-Meteo did not return current weather data.",
          summary: "Weather service did not return data for this location.",
        };
        return weatherConfig.structuredResultEnabled
          ? JSON.stringify(result)
          : "Weather forecast API did not return current weather data.";
      }

      const result = buildSuccessResult(query, place, forecast, forecastUrl.toString());

      await recordMetric("weather.location.resolve.success.count", { count: 1 });
      await recordMetric("weather.provider.forecast.duration_ms", {
        durationMs: Date.now() - startTime,
      });
      await auditLogger.record("weather.location.resolve.success", {
        raw: query.raw,
        provider: place.provider,
        strategy: resolutionResult.strategy,
        candidateCount: 1,
        durationMs: Date.now() - startTime,
      });

      return weatherConfig.structuredResultEnabled
        ? JSON.stringify(result)
        : formatLegacyText(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const result: WeatherToolResult = {
        schemaVersion: "1.0",
        tool: "current_weather",
        status: "error",
        requestedLocation: query,
        code: isCancelError(errorMessage)
          ? "weather_cancelled"
          : isTimeoutError(errorMessage)
          ? "weather_timeout"
          : "weather_forecast_provider_error",
        retryable: !isCancelError(errorMessage) && (isTimeoutError(errorMessage) || errorMessage.includes("fetch failed")),
        message: errorMessage,
        summary: isCancelError(errorMessage)
          ? "Weather lookup was cancelled."
          : "Weather forecast service is temporarily unavailable.",
      };
      await recordMetric("weather.provider.forecast.failure.count", { count: 1 });
      await auditLogger.record("weather.provider.forecast.failure", {
        raw: query.raw,
        error: errorMessage,
        durationMs: Date.now() - startTime,
      });
      return weatherConfig.structuredResultEnabled
        ? JSON.stringify(result)
        : "Weather forecast service is temporarily unavailable.";
    }
  },
  {
    name: "current_weather",
    description:
      "Get real-time current weather for a city or location using Open-Meteo. Use this only for current weather, current temperature, humidity, current rain, or current wind questions. For tomorrow, tonight, weekend, date range, or rain probability forecast questions, use weather_forecast. Provide country or region when the location is ambiguous. The tool does not contain built-in city aliases; pass the most geocoding-friendly place name you can infer.",
    schema: z.object({
      location: z.string().min(1).describe("City or location name."),
      country: z
        .string()
        .optional()
        .describe("Optional country hint, for example 'Taiwan', 'Japan', or 'United States'."),
      region: z
        .string()
        .optional()
        .describe("Optional state, province, or administrative region hint, for example 'New York'."),
      resolutionStrategy: z
        .enum(["llm_repair"])
        .optional()
        .describe("Internal marker for one-time LLM repair; callers should normally omit this."),
      raw: z
        .string()
        .optional()
        .describe("Internal original user location text preserved across one-time repair."),
      queryName: z
        .string()
        .optional()
        .describe("Optional geocoding-friendly Latin name for Chinese or mixed-Chinese locations."),
      resolvedCandidate: resolvedCandidateSchema
        .optional()
        .describe("Internal resolved geocoding candidate for checkpoint resume; callers should normally omit this."),
    }),
  }
);
