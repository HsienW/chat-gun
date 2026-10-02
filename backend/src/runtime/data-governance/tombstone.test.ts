import { describe, expect, it } from "vitest";

import {
  InMemoryTombstoneCache,
  InMemoryTombstoneRepository,
  LateEventGuard,
  TombstoneService,
  minimizeAuditEvidence,
} from "./tombstone.js";

describe("TombstoneService", () => {
  it("returns deleted and refills cache from the durable tombstone", async () => {
    const repository = new InMemoryTombstoneRepository();
    const writer = new TombstoneService(
      repository,
      new InMemoryTombstoneCache(),
      { activeRecordTtlSeconds: 60, tombstoneTtlSeconds: 120 },
    );
    await writer.recordDeletion({
      subjectId: "acct_01",
      objectId: "task_01",
      deletionReason: "SUBJECT_REQUEST",
    });

    const reader = new TombstoneService(
      repository,
      new InMemoryTombstoneCache(),
      { activeRecordTtlSeconds: 60, tombstoneTtlSeconds: 120 },
    );
    await expect(
      reader.lookup({ subjectId: "acct_01", objectId: "task_01" }),
    ).resolves.toMatchObject({ status: "deleted", tombstoneVersion: 1 });
    await expect(
      reader.lookup({ subjectId: "acct_02", objectId: "task_01" }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("rejects a tombstone cache TTL shorter than the active record TTL", () => {
    expect(
      () =>
        new TombstoneService(
          new InMemoryTombstoneRepository(),
          new InMemoryTombstoneCache(),
          { activeRecordTtlSeconds: 120, tombstoneTtlSeconds: 60 },
        ),
    ).toThrow("TOMBSTONE_TTL_TOO_SHORT");
  });
});

describe("LateEventGuard", () => {
  it.each(["reject", "quarantine", "redact"] as const)(
    "applies the %s policy without allowing a tombstoned write",
    async (policy) => {
      const service = new TombstoneService(
        new InMemoryTombstoneRepository(),
        new InMemoryTombstoneCache(),
        { activeRecordTtlSeconds: 60, tombstoneTtlSeconds: 60 },
      );
      await service.recordDeletion({
        subjectId: "acct_01",
        deletionReason: "SUBJECT_REQUEST",
      });
      const guard = new LateEventGuard(service);

      const result = await guard.evaluate(
        {
          subjectId: "acct_01",
          eventId: "event_01",
          payload: { email: "person@example.com" },
        },
        policy,
      );

      expect(result.action).toBe(policy);
      expect(result.allowWrite).toBe(false);
      expect(JSON.stringify(result)).not.toContain("person@example.com");
    },
  );
});

describe("audit evidence minimization", () => {
  it("keeps only identifier-minimized immutable evidence", () => {
    const evidence = minimizeAuditEvidence({
      subjectId: "person@example.com",
      eventId: "event_01",
      reasonCode: "LEGAL_AUDIT_MINIMUM",
      evidenceRef: "receipt:receipt_01",
      legalBasis: "policy:minimum-audit-evidence",
      recordedAt: "2026-09-30T00:00:00.000Z",
    });

    expect(evidence.subjectIdHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence).toMatchObject({
      eventId: "event_01",
      reasonCode: "LEGAL_AUDIT_MINIMUM",
      identifierMinimized: true,
      legalBasis: "policy:minimum-audit-evidence",
    });
    expect(JSON.stringify(evidence)).not.toContain("person@example.com");
    expect(JSON.stringify(evidence)).not.toContain("token");
  });
});
