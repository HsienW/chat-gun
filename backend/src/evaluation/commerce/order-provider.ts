import { MockOrderProvider, type MockOrderProviderOptions } from "../../tools/orders/mock-order-provider.js";

/** Evaluation owns its fixture identity. Production owner binding is never accepted or read. */
export function createEvaluationOrderProvider(options: Omit<MockOrderProviderOptions, "ownerBinding">): MockOrderProvider {
  return new MockOrderProvider({
    fixture: options.fixture,
    faults: options.faults,
    now: options.now,
    createExternalOperationId: options.createExternalOperationId,
    beforeCommit: options.beforeCommit,
  });
}
