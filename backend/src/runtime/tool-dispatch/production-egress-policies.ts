import {
  createEgressPolicy,
  PUBLIC_INTERNET_DESTINATION,
} from "./egress-policy.js";
import type { EgressRequirements } from "./execution-profile.js";

export const PRODUCTION_EGRESS_REQUIREMENTS = {
  web_search: {
    destinations: ["api.tavily.com"],
    protocols: ["https"],
  },
  web_fetch: {
    destinations: [PUBLIC_INTERNET_DESTINATION],
    protocols: ["http", "https"],
  },
  current_weather: {
    destinations: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
    protocols: ["https"],
  },
  weather_forecast: {
    destinations: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
    protocols: ["https"],
  },
} as const satisfies Readonly<Record<string, EgressRequirements>>;

export const WEB_SEARCH_EGRESS_POLICY = createEgressPolicy(
  PRODUCTION_EGRESS_REQUIREMENTS.web_search
);
export const WEB_FETCH_EGRESS_POLICY = createEgressPolicy(
  PRODUCTION_EGRESS_REQUIREMENTS.web_fetch
);
export const WEATHER_EGRESS_POLICY = createEgressPolicy(
  PRODUCTION_EGRESS_REQUIREMENTS.current_weather
);
