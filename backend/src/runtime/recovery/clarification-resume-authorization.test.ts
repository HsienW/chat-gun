import { describe, expect, it } from "vitest";

import { deepResearcherExecutionManifest } from "../../agents/deep-researcher-graph-contract.js";
import type { ActiveRunOwnership } from "../interaction/ownership.js";
import { createClarificationResumeAuthorizer } from "./clarification-resume-authorization.js";
import type { InterruptManifestRepository } from "./interrupt-manifest-repository.js";
import {
  parseDurableInterruptManifest,
  type DurableInterruptManifest,
} from "./interrupt-manifest.js";
import { createResumeResponseSchemaRegistry } from "./resume-response-schema-registry.js";

function createRepository(initial: DurableInterruptManifest) {
  let manifest = initial;
  const repository: InterruptManifestRepository = {
    async create(value) {
      manifest = value;
      return value;
    },
    async findByInterruptId(interruptId) {
      return manifest.interruptId === interruptId ? manifest : null;
    },
    async consume(input) {
      if (
        manifest.status !== "waiting" ||
        manifest.interruptId !== input.interruptId ||
        manifest.runId !== input.runId ||
        manifest.taskId !== input.taskId ||
        manifest.scopeId !== input.scopeId
      ) {
        return null;
      }
      manifest = { ...manifest, status: "resumed" };
      return manifest;
    },
    async transitionStatus(input) {
      if (manifest.status !== input.expectedStatus) return null;
      manifest = { ...manifest, status: input.nextStatus };
      return manifest;
    },
  };
  return repository;
}

const manifest = parseDurableInterruptManifest({
  interruptId: `clarification:${"a".repeat(64)}`,
  kind: "clarification",
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  scopeId: "scope-1",
  expectedResponseSchemaRef: "weather_clarification_resume@1.0",
  expiryAt: "2099-01-01T00:00:00.000Z",
  executionManifest: deepResearcherExecutionManifest,
  status: "waiting",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
});

const ownership: ActiveRunOwnership = {
  threadId: "thread-1",
  runId: "run-1",
  taskId: "task-1",
  scopeId: "scope-1",
  status: "active",
  generation: 1,
  updatedAt: "2026-09-28T00:00:00.000Z",
};

function createAuthorizer(repository: InterruptManifestRepository) {
  return createClarificationResumeAuthorizer({
    manifests: repository,
    responseSchemas: createResumeResponseSchemaRegistry(),
    resolveCurrentExecutionManifest: (graphId) =>
      graphId === deepResearcherExecutionManifest.graphId
        ? deepResearcherExecutionManifest
        : undefined,
  });
}

describe("clarification resume authorization", () => {
  it("consumes a valid scoped response once and rejects replay", async () => {
    const authorize = createAuthorizer(createRepository(manifest));
    const request = {
      interruptId: manifest.interruptId,
      response: { userReply: "Taipei City" },
      threadId: "thread-1",
      scopeId: "scope-1",
      activeOwnership: ownership,
    };

    await expect(authorize(request)).resolves.toEqual({ ok: true });
    await expect(authorize(request)).resolves.toEqual({
      ok: false,
      reasonCode: "CLARIFICATION_MANIFEST_NOT_WAITING",
    });
  });

  it("fails closed for mismatched correlation and invalid payload", async () => {
    const authorize = createAuthorizer(createRepository(manifest));

    await expect(
      authorize({
        interruptId: manifest.interruptId,
        response: { userReply: "Taipei" },
        threadId: "other-thread",
        scopeId: "scope-1",
        activeOwnership: ownership,
      })
    ).resolves.toEqual({
      ok: false,
      reasonCode: "CLARIFICATION_MANIFEST_CORRELATION_MISMATCH",
    });
    await expect(
      authorize({
        interruptId: manifest.interruptId,
        response: { unsupported: true },
        threadId: "thread-1",
        scopeId: "scope-1",
        activeOwnership: ownership,
      })
    ).resolves.toEqual({
      ok: false,
      reasonCode: "CLARIFICATION_RESPONSE_INVALID",
    });
  });
});
