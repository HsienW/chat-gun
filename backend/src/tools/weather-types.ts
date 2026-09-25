// Domain types for location resolution (Task 2.1, 4.1)
// This file defines the core domain types for the generalized weather location resolution pipeline.

export type LocationQuery = {
  /** Original location text from user or planner, preserved as-is */
  raw: string;
  /** Trimmed and Unicode-normalized primary query */
  location: string;
  /** Optional country hint */
  country?: string;
  /** Optional region / administrative area hint */
  region?: string;
};

export type LocationCandidate = {
  provider: "open-meteo";
  providerId?: string;
  name: string;
  displayName: string;
  country?: string;
  countryCode?: string;
  admin1?: string;
  admin2?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  population?: number;
};

export type LocationResolutionResult =
  | {
      status: "resolved";
      query: LocationQuery;
      candidate: LocationCandidate;
      confidence: number;
      strategy: ResolutionStrategy;
      attemptedQueries: string[];
    }
  | {
      status: "ambiguous";
      query: LocationQuery;
      candidates: LocationCandidate[];
      reason: AmbiguityReason;
      attemptedQueries: string[];
    }
  | {
      status: "not_found";
      query: LocationQuery;
      attemptedQueries: string[];
    }
  | {
      status: "provider_error";
      query: LocationQuery;
      provider: "open-meteo";
      code: string;
      retryable: boolean;
    };

export type ResolutionStrategy =
  | "original"
  | "contextual"
  | "locale_fallback"
  | "llm_repair";

export type AmbiguityReason = "score_too_close" | "missing_country_or_region";

// Weather tool structured result (Task 4.1 - 4.9)
export type WeatherToolResult =
  | WeatherSuccessResult
  | WeatherClarificationResult
  | WeatherNotFoundResult
  | WeatherErrorResult
  | WeatherForecastResult;

export type WeatherCapability = "current" | "hourly" | "daily";

export type WeatherTimeRangeKind =
  | "now"
  | "today"
  | "tonight"
  | "tomorrow"
  | "weekend"
  | "date_range";

export type WeatherTimeRange = {
  kind: WeatherTimeRangeKind;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  granularity?: "hourly" | "daily";
};

export type WeatherSuccessResult = {
  schemaVersion: "1.0";
  tool: "current_weather";
  status: "success";
  requestedLocation: LocationQuery;
  resolvedLocation: LocationCandidate;
  observedAt: string;
  timezone: string;
  current: WeatherCurrentData;
  units: Record<string, string>;
  provider: "Open-Meteo";
  sourceUrl: string;
  summary: string;
};

export type WeatherCurrentData = {
  conditionCode?: number;
  conditionText: string;
  temperature?: number;
  apparentTemperature?: number;
  relativeHumidity?: number;
  precipitation?: number;
  rain?: number;
  cloudCover?: number;
  pressureMsl?: number;
  windSpeed?: number;
  windDirectionDegrees?: number;
  windDirectionText?: string;
  windGusts?: number;
};

export type WeatherClarificationResult = {
  schemaVersion: "1.0";
  tool: "current_weather";
  status: "needs_clarification";
  requestedLocation: LocationQuery;
  candidates: Array<
    Pick<LocationCandidate, "name" | "displayName" | "country" | "countryCode" | "admin1" | "admin2"> &
      Partial<Pick<LocationCandidate, "providerId" | "latitude" | "longitude" | "timezone">>
  >;
  message: string;
  summary: string;
};

export type WeatherNotFoundResult = {
  schemaVersion: "1.0";
  tool: "current_weather";
  status: "not_found";
  requestedLocation: LocationQuery;
  code: "weather_location_not_found";
  message: string;
  summary: string;
  attemptedQueries?: string[];
};

export type WeatherErrorResult = {
  schemaVersion: "1.0";
  tool: "current_weather";
  status: "error";
  requestedLocation: LocationQuery;
  code: WeatherErrorCode;
  retryable: boolean;
  message: string;
  summary: string;
};

export type WeatherErrorCode =
  | "weather_invalid_input"
  | "weather_geocoding_provider_error"
  | "weather_forecast_provider_error"
  | "weather_timeout"
  | "weather_cancelled"
  | "weather_unknown_error";

export type WeatherForecastResult =
  | WeatherForecastSuccessResult
  | WeatherForecastClarificationResult
  | WeatherForecastNotFoundResult
  | WeatherForecastErrorResult;

export type WeatherForecastSuccessResult = {
  schemaVersion: "1.1";
  tool: "weather_forecast";
  status: "success";
  requestedLocation: LocationQuery;
  resolvedLocation: LocationCandidate;
  weatherCapability: Exclude<WeatherCapability, "current">;
  timeRange: WeatherTimeRange;
  generatedAt: string;
  timezone: string;
  daily?: WeatherDailyForecastEntry[];
  hourly?: WeatherHourlyForecastEntry[];
  units: Record<string, string>;
  provider: "Open-Meteo";
  sourceUrl: string;
  summary: string;
};

export type WeatherDailyForecastEntry = {
  date: string;
  conditionCode?: number;
  conditionText?: string;
  temperatureMax?: number;
  temperatureMin?: number;
  precipitationProbabilityMax?: number;
  precipitationSum?: number;
};

export type WeatherHourlyForecastEntry = {
  time: string;
  conditionCode?: number;
  conditionText?: string;
  temperature?: number;
  precipitationProbability?: number;
  precipitation?: number;
};

export type WeatherForecastClarificationResult = {
  schemaVersion: "1.1";
  tool: "weather_forecast";
  status: "needs_clarification";
  requestedLocation: LocationQuery;
  candidates: Array<
    Pick<LocationCandidate, "name" | "displayName" | "country" | "countryCode" | "admin1" | "admin2"> &
      Partial<Pick<LocationCandidate, "providerId" | "latitude" | "longitude" | "timezone">>
  >;
  message: string;
  summary: string;
};

export type WeatherForecastNotFoundResult = {
  schemaVersion: "1.1";
  tool: "weather_forecast";
  status: "not_found";
  requestedLocation: LocationQuery;
  code: "weather_location_not_found";
  message: string;
  summary: string;
  attemptedQueries?: string[];
};

export type WeatherForecastErrorResult = {
  schemaVersion: "1.1";
  tool: "weather_forecast";
  status: "error";
  requestedLocation: LocationQuery;
  code: WeatherErrorCode;
  retryable: boolean;
  message: string;
  summary: string;
};

// Geocoding Provider Interface (Task 3.1)
export interface GeocodingProvider {
  readonly name: string;

  search(
    query: GeocodingSearchQuery
  ): Promise<LocationCandidate[]>;
}

export type GeocodingSearchQuery = {
  text: string;
  language?: string;
  limit: number;
  signal?: AbortSignal;
};

export type GeocodingQueryVariant = {
  text: string;
  language?: string;
  strategy: ResolutionStrategy;
};

// Deep Research Weather Execution State (Task 5.1)
export type WeatherExecutionState =
  | { status: "idle" }
  | { status: "running"; requestedLocation: LocationQuery }
  | { status: "success"; result: WeatherToolResult }
  | { status: "needs_clarification"; result: WeatherToolResult }
  | { status: "failed"; result: WeatherToolResult };

export type WeatherClarificationCandidate = Pick<
  LocationCandidate,
  | "provider"
  | "providerId"
  | "name"
  | "displayName"
  | "country"
  | "countryCode"
  | "admin1"
  | "admin2"
  | "latitude"
  | "longitude"
  | "timezone"
>;

export type WeatherClarificationInterrupt = {
  type: "weather_clarification";
  eventType: "clarification_requested";
  interruptId: string;
  threadId: string;
  runId: string;
  candidates: Array<WeatherClarificationCandidate & { index: number }>;
  originalQuery: LocationQuery;
  weatherCapability: WeatherCapability;
  timeRange?: WeatherTimeRange;
  summary: string;
  weatherExecution: Extract<WeatherExecutionState, { status: "needs_clarification" }>;
};

export type WeatherClarificationResolution =
  | { resolutionType: "select_candidate"; candidateIndex: number }
  | {
      resolutionType: "filter_candidates";
      filter: {
        country?: string;
        region?: string;
        name?: string;
      };
    }
  | { resolutionType: "new_location"; newLocationText: string }
  | { resolutionType: "cancel"; cancel: true }
  | { resolutionType: "unrecognized" };

export type WeatherClarificationState = {
  status: "awaiting_user_input" | "resuming" | "resolved" | "cancelled" | "timeout" | "exhausted";
  candidates: WeatherClarificationCandidate[];
  originalQuery: LocationQuery;
  weatherCapability: WeatherCapability;
  timeRange?: WeatherTimeRange;
  summary: string;
  interruptCheckpointStep: number;
  rounds: number;
  userReply?: string;
  resolution?: WeatherClarificationResolution;
};
