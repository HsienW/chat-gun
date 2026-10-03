import { describe, expect, it } from "vitest";

import { CONSENT_RECORD_SCHEMA_VERSION } from "./contracts.js";
import {
  ConsentService,
  InMemoryConsentRecordStore,
} from "./consent.js";

describe("ConsentService", () => {
  it("keeps versioned consent records append-only", async () => {
    const store = new InMemoryConsentRecordStore();
    const service = new ConsentService(store);
    const grant = {
      schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
      consentId: "consent_01",
      accountId: "acct_01",
      policyVersion: 1,
      status: "granted" as const,
      scope: "personalization" as const,
      recordedAt: "2026-09-29T00:00:00.000Z",
    };

    await service.record(grant);
    await expect(service.record(grant)).rejects.toThrow("CONSENT_ID_ALREADY_EXISTS");

    const snapshot = await store.listByAccount("acct_01");
    snapshot[0]!.status = "withdrawn";
    expect((await store.listByAccount("acct_01"))[0]?.status).toBe("granted");
  });

  it("applies withdrawal only to future processing at resume boundaries", async () => {
    const store = new InMemoryConsentRecordStore();
    const service = new ConsentService(store);
    await service.record({
      schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
      consentId: "consent_01",
      accountId: "acct_01",
      policyVersion: 1,
      status: "granted",
      scope: "evaluation_contribution",
      recordedAt: "2026-09-29T00:00:00.000Z",
    });

    const historicalDecision = await service.checkResumeBoundary(
      "acct_01",
      "evaluation_contribution",
    );
    await service.record({
      schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
      consentId: "consent_02",
      accountId: "acct_01",
      policyVersion: 2,
      status: "withdrawn",
      scope: "evaluation_contribution",
      recordedAt: "2026-09-30T00:00:00.000Z",
    });

    expect(historicalDecision).toEqual({
      allowed: true,
      consentId: "consent_01",
      policyVersion: 1,
    });
    await expect(
      service.checkResumeBoundary("acct_01", "evaluation_contribution"),
    ).resolves.toEqual({
      allowed: false,
      reasonCode: "CONSENT_WITHDRAWN",
      consentId: "consent_02",
      policyVersion: 2,
    });
    expect((await store.listByAccount("acct_01"))).toHaveLength(2);
  });

  it("uses the structured status and fails closed without a record", async () => {
    const service = new ConsentService(new InMemoryConsentRecordStore());

    await expect(
      service.checkResumeBoundary("acct_01", "proactive_background_work"),
    ).resolves.toEqual({
      allowed: false,
      reasonCode: "CONSENT_NOT_FOUND",
    });
  });
});
