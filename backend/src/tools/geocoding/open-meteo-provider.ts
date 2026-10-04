// Open-Meteo Geocoding Provider — Task 3.2, 3.3
// Wraps Open-Meteo Geocoding API calls behind the GeocodingProvider interface.

import { GeocodingProvider, GeocodingSearchQuery, LocationCandidate } from "../weather-types.js";
import { fetchWithValidatedRedirects } from "../../runtime/tool-dispatch/egress-policy.js";
import { WEATHER_EGRESS_POLICY } from "../../runtime/tool-dispatch/production-egress-policies.js";

const GEOCODING_BASE_URL = "https://geocoding-api.open-meteo.com/v1/search";

type OpenMeteoGeocodingResult = {
  id?: number;
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

type OpenMeteoGeocodingResponse = {
  results?: OpenMeteoGeocodingResult[];
};

export class OpenMeteoGeocodingProvider implements GeocodingProvider {
  readonly name = "open-meteo";
  private defaultTimeoutMs: number;

  constructor(timeoutMs: number = 5_000) {
    this.defaultTimeoutMs = timeoutMs;
  }

  async search(query: GeocodingSearchQuery): Promise<LocationCandidate[]> {
    const url = this.buildUrl(query);
    const signal = this.mergeSignals(query.signal, this.defaultTimeoutMs);

    try {
      const response = await fetchWithValidatedRedirects(
        url,
        {
          signal,
          headers: {
            "User-Agent": "chat-gun/0.1",
          },
        },
        WEATHER_EGRESS_POLICY
      );

      if (!response.ok) {
        throw new Error(
          `Geocoding provider returned HTTP ${response.status}: ${response.statusText}`
        );
      }

      const data = (await response.json()) as OpenMeteoGeocodingResponse;
      return (data.results ?? []).map((result) => this.toCandidate(result));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (query.signal?.aborted) {
          throw new Error("weather_geocoding_cancelled");
        }
        throw new Error("weather_geocoding_timeout");
      }
      throw error;
    }
  }

  private buildUrl(query: GeocodingSearchQuery): URL {
    const url = new URL(GEOCODING_BASE_URL);
    url.searchParams.set("name", query.text);
    url.searchParams.set("count", String(Math.min(query.limit, 10)));
    url.searchParams.set("format", "json");

    if (query.language) {
      url.searchParams.set("language", query.language);
    }

    return url;
  }

  private mergeSignals(
    externalSignal?: AbortSignal,
    timeoutMs?: number
  ): AbortSignal | undefined {
    if (!timeoutMs && !externalSignal) {
      return undefined;
    }

    if (externalSignal?.aborted) {
      const controller = new AbortController();
      controller.abort();
      return controller.signal;
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (externalSignal) {
        try {
          externalSignal.removeEventListener("abort", onExternalAbort);
        } catch {
          // ignore if listener was already removed
        }
      }
    };

    const onExternalAbort = () => {
      cleanup();
      controller.abort();
    };

    if (timeoutMs) {
      timeoutId = setTimeout(() => {
        cleanup();
        controller.abort();
      }, timeoutMs);
    }

    if (externalSignal) {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    // Return the signal wrapped with cleanup
    return controller.signal;
  }

  private toCandidate(result: OpenMeteoGeocodingResult): LocationCandidate {
    return {
      provider: "open-meteo",
      providerId: result.id?.toString(),
      name: result.name,
      displayName: [result.name, result.admin2, result.admin1, result.country]
        .filter(Boolean)
        .join(", "),
      country: result.country,
      countryCode: result.country_code,
      admin1: result.admin1,
      admin2: result.admin2,
      latitude: result.latitude,
      longitude: result.longitude,
      timezone: result.timezone,
      population: result.population,
    };
  }
}
