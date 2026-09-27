import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/runtime-event-contract.fixture.json';

import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  RUNTIME_EVENT_TYPES,
} from './runtime-event-envelope';
import { RUN_TERMINAL_STATUSES, RUN_WAITING_STATUSES } from './runtime-run-status';

describe('runtime event cross-layer contract', () => {
  it('matches the shared schema, event types, and run statuses', () => {
    expect(RUNTIME_EVENT_SCHEMA_VERSION).toBe(fixture.schemaVersion);
    expect(RUNTIME_EVENT_TYPES).toEqual(fixture.eventTypes);
    expect(RUN_TERMINAL_STATUSES).toEqual(fixture.terminalStatuses);
    expect(RUN_WAITING_STATUSES).toEqual(fixture.waitingStatuses);
  });
});
