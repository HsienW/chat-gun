import {
  ActiveRunOwnershipConflictError,
  type ActiveRunOwnership,
  type ActiveRunOwnershipRepository,
} from "../interaction/ownership.js";

export type QueryGuardState = "idle" | "dispatching" | "running";

export interface QueryScope {
  threadId: string;
  scopeId: string;
  taskId: string;
  runId: string;
}

export interface QueryGuardEntry {
  state: Exclude<QueryGuardState, "idle">;
  runId: string;
  generation: number;
}

export type ReserveResult =
  | { reserved: true; ownership: ActiveRunOwnership }
  | {
      reserved: false;
      reason: "dispatch_in_progress" | "ownership_conflict";
      ownership?: ActiveRunOwnership;
    };

export interface QueryGuard {
  reserve(scope: QueryScope, generation: number): Promise<ReserveResult>;
  dispatch(scope: QueryScope, generation: number): Promise<void>;
  release(scope: QueryScope, generation: number): Promise<void>;
  adopt(
    ownership: ActiveRunOwnership,
    state: Exclude<QueryGuardState, "idle">,
  ): void;
}

export class GenerationQueryGuard implements QueryGuard {
  private readonly entries = new Map<string, QueryGuardEntry>();
  private readonly pendingReservations = new Map<string, Promise<ReserveResult>>();

  constructor(
    private readonly ownershipRepository: ActiveRunOwnershipRepository,
  ) {}

  async reserve(
    scope: QueryScope,
    generation: number,
  ): Promise<ReserveResult> {
    requireGeneration(generation);
    const key = scopeKey(scope);
    const current = this.entries.get(key);
    if (current) {
      return this.resolveExistingReservation(scope, generation, key, current);
    }

    const provisional: QueryGuardEntry = {
      state: "dispatching",
      runId: scope.runId,
      generation,
    };
    this.entries.set(key, provisional);

    const pendingReservation = this.reserveDurably(scope, provisional, key);
    this.pendingReservations.set(key, pendingReservation);
    try {
      return await pendingReservation;
    } finally {
      if (this.pendingReservations.get(key) === pendingReservation) {
        this.pendingReservations.delete(key);
      }
    }
  }

  private async reserveDurably(
    scope: QueryScope,
    provisional: QueryGuardEntry,
    key: string,
  ): Promise<ReserveResult> {
    try {
      const active = await this.ownershipRepository.findActive(
        scope.threadId,
        scope.scopeId,
      );
      if (active) {
        if (this.entries.get(key) === provisional) {
          this.entries.delete(key);
        }
        this.adopt(active, "running");
        return {
          reserved: false,
          reason: "ownership_conflict",
          ownership: active,
        };
      }

      const ownership = await this.ownershipRepository.claim(scope);
      if (this.entries.get(key) === provisional) {
        this.entries.set(key, {
          state: "dispatching",
          runId: ownership.runId,
          generation: ownership.generation,
        });
      }
      return { reserved: true, ownership };
    } catch (error) {
      if (!(error instanceof ActiveRunOwnershipConflictError)) {
        if (this.entries.get(key) === provisional) {
          this.entries.delete(key);
        }
        throw error;
      }

      if (this.entries.get(key) === provisional) {
        this.entries.delete(key);
      }
      const ownership = await this.ownershipRepository.findActive(
        scope.threadId,
        scope.scopeId,
      );
      if (ownership) {
        this.adopt(ownership, "running");
        return {
          reserved: false,
          reason: "ownership_conflict",
          ownership,
        };
      }
      return {
        reserved: false,
        reason: "ownership_conflict",
        ...(ownership ? { ownership } : {}),
      };
    }
  }

  private async resolveExistingReservation(
    scope: QueryScope,
    generation: number,
    key: string,
    current: QueryGuardEntry,
  ): Promise<ReserveResult> {
    const pendingReservation = this.pendingReservations.get(key);
    if (pendingReservation) {
      try {
        await pendingReservation;
      } catch {
        // The original caller receives the claim failure. This caller can retry
        // only after the provisional local entry has been removed.
      }
    }

    const active = await this.ownershipRepository.findActive(
      scope.threadId,
      scope.scopeId,
    );
    if (active) {
      this.adopt(
        active,
        active.runId === current.runId ? current.state : "running",
      );
      return {
        reserved: false,
        reason: "ownership_conflict",
        ownership: active,
      };
    }

    if (this.entries.get(key) === current) {
      this.entries.delete(key);
    }
    return this.reserve(scope, generation);
  }

  async dispatch(scope: QueryScope, generation: number): Promise<void> {
    const key = scopeKey(scope);
    const current = this.entries.get(key);
    if (
      current?.state !== "dispatching" ||
      current.runId !== scope.runId ||
      current.generation !== generation
    ) {
      return;
    }
    this.entries.set(key, { ...current, state: "running" });
  }

  async release(scope: QueryScope, generation: number): Promise<void> {
    const key = scopeKey(scope);
    const current = this.entries.get(key);
    if (
      current?.runId === scope.runId &&
      current.generation === generation
    ) {
      this.entries.delete(key);
    }
  }

  adopt(
    ownership: ActiveRunOwnership,
    state: Exclude<QueryGuardState, "idle">,
  ): void {
    this.entries.set(scopeKey(ownership), {
      state,
      runId: ownership.runId,
      generation: ownership.generation,
    });
  }

  read(scope: Pick<QueryScope, "threadId" | "scopeId">):
    | QueryGuardEntry
    | undefined {
    const entry = this.entries.get(scopeKey(scope));
    return entry ? { ...entry } : undefined;
  }
}

function scopeKey(scope: Pick<QueryScope, "threadId" | "scopeId">): string {
  return `${scope.threadId.length}:${scope.threadId}${scope.scopeId}`;
}

function requireGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Query guard generation must be a positive safe integer");
  }
}
