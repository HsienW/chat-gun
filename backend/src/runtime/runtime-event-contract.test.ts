import { describe, expect, it } from "vitest";

import fixture from "../../../contracts/runtime-event-contract.fixture.json" with { type: "json" };
import { RUNTIME_EVENT_SCHEMA_VERSION } from "./event-envelope.js";
import {
  LEGACY_RUNTIME_EVENT_TYPE_MAP,
  RUNTIME_EVENT_TYPES,
} from "./event-payloads.js";
import { RUN_TERMINAL_STATUSES, RUN_WAITING_STATUSES } from "./run-status.js";

describe("runtime event cross-layer contract", () => {
  it("matches the shared schema, event types, statuses, and legacy mapping", () => {
    expect(RUNTIME_EVENT_SCHEMA_VERSION).toBe(fixture.schemaVersion);
    expect(RUNTIME_EVENT_TYPES).toEqual(fixture.eventTypes);
    expect(RUN_TERMINAL_STATUSES).toEqual(fixture.terminalStatuses);
    expect(RUN_WAITING_STATUSES).toEqual(fixture.waitingStatuses);
    expect(LEGACY_RUNTIME_EVENT_TYPE_MAP).toEqual(fixture.legacyTypeMappings);
  });
});
