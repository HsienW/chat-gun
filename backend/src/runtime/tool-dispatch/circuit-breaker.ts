import type { ToolCircuitBreakerPolicy } from "./runtime-tool-descriptor.js";

export type CircuitState = "closed" | "open" | "half_open";
export type CircuitRecordOutcome = "success" | "definitive_failure";

export interface ToolCircuitBreaker {
  beforeDispatch(
    toolName: string,
    policy: ToolCircuitBreakerPolicy | undefined
  ): CircuitState;
  record(
    toolName: string,
    policy: ToolCircuitBreakerPolicy | undefined,
    outcome: CircuitRecordOutcome
  ): void;
}

interface CircuitEntry {
  state: CircuitState;
  failureCount: number;
  halfOpenProbeCount: number;
  halfOpenSuccessCount: number;
  openedAt?: number;
}

function createClosedEntry(): CircuitEntry {
  return {
    state: "closed",
    failureCount: 0,
    halfOpenProbeCount: 0,
    halfOpenSuccessCount: 0,
  };
}

export class InMemoryToolCircuitBreaker implements ToolCircuitBreaker {
  private readonly circuits = new Map<string, CircuitEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  beforeDispatch(
    toolName: string,
    policy: ToolCircuitBreakerPolicy | undefined
  ): CircuitState {
    if (policy === undefined) {
      return "closed";
    }

    const entry = this.circuits.get(toolName) ?? createClosedEntry();
    if (entry.state === "closed") {
      return "closed";
    }

    const checkedAt = this.now();
    if (entry.state === "open") {
      const openedAt = entry.openedAt ?? checkedAt;
      if (checkedAt - openedAt < policy.resetTimeoutMs) {
        return "open";
      }
      entry.state = "half_open";
      entry.halfOpenProbeCount = 0;
      entry.halfOpenSuccessCount = 0;
      this.circuits.set(toolName, entry);
    }

    if (entry.halfOpenProbeCount >= policy.halfOpenMaxProbes) {
      this.open(entry, checkedAt);
      return "open";
    }

    entry.halfOpenProbeCount += 1;
    return "half_open";
  }

  record(
    toolName: string,
    policy: ToolCircuitBreakerPolicy | undefined,
    outcome: CircuitRecordOutcome
  ): void {
    if (policy === undefined) {
      return;
    }

    const entry = this.circuits.get(toolName) ?? createClosedEntry();
    if (outcome === "success") {
      if (entry.state === "half_open") {
        entry.halfOpenSuccessCount += 1;
        if (entry.halfOpenSuccessCount >= policy.successThreshold) {
          this.circuits.delete(toolName);
        }
        return;
      }
      if (entry.state === "closed") {
        this.circuits.delete(toolName);
      }
      return;
    }

    if (entry.state === "half_open" || entry.state === "open") {
      this.open(entry, this.now());
      this.circuits.set(toolName, entry);
      return;
    }

    entry.failureCount += 1;
    if (entry.failureCount >= policy.failureThreshold) {
      this.open(entry, this.now());
    }
    this.circuits.set(toolName, entry);
  }

  private open(entry: CircuitEntry, openedAt: number): void {
    entry.state = "open";
    entry.failureCount = 0;
    entry.halfOpenProbeCount = 0;
    entry.halfOpenSuccessCount = 0;
    entry.openedAt = openedAt;
  }
}

export type { ToolCircuitBreakerPolicy } from "./runtime-tool-descriptor.js";
