import { describe, expect, it, vi } from "vitest";
import { runBoundedAdapterOperation } from "./bounded-operation.js";

describe("bounded adapter operation", () => {
  it.each([0, -1, Infinity, NaN, 0.5, 2_147_483_648])("rejects invalid deadline %s before starting", async (timeoutMs) => {
    const operation = vi.fn();
    await expect(runBoundedAdapterOperation(operation, { timeoutMs })).rejects.toMatchObject({ code: "ADAPTER_INVALID_DEADLINE" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects pre-cancelled requests without starting", async () => {
    const operation = vi.fn();
    await expect(runBoundedAdapterOperation(operation, { timeoutMs: 100, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ADAPTER_OPERATION_CANCELLED" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("sanitizes failures and aborts cooperative sibling work", async () => {
    let signal: AbortSignal | undefined;
    await expect(runBoundedAdapterOperation(async (forwarded) => {
      signal = forwarded;
      throw new Error("internal secret");
    }, { timeoutMs: 100 })).rejects.toMatchObject({ code: "ADAPTER_OPERATION_FAILED", message: "ADAPTER_OPERATION_FAILED" });
    expect(signal?.aborted).toBe(true);
  });
});
