import { randomUUID } from "node:crypto";

import {
  ORDER_EFFECT_RESULT_VERSION,
  type OrderEffectResult,
  type OrderFailureCode,
} from "./order-contracts.js";
import type { SyntheticOrder, SyntheticOrderFixture } from "./synthetic-orders.js";

export class OrderProviderError extends Error {
  readonly name = "OrderProviderError";

  constructor(readonly code: OrderFailureCode) {
    super(code);
  }
}

/** The requester always comes from the server-side execution context. */
export interface OrderRequester {
  tenantId: string;
  principalId: string;
}

export interface SubmitRefundRequest {
  businessEffectKey: string;
  requester: OrderRequester;
  orderId: string;
  /** Omitted for the whole order. */
  lineItems?: readonly { lineItemId: string; quantity: number }[];
  reasonCode: string;
  note?: string;
}

export interface SubmitCancelRequest {
  businessEffectKey: string;
  requester: OrderRequester;
  orderId: string;
  reasonCode: string;
  note?: string;
}

export type OrderProviderLookupResult =
  | { state: "committed"; effect: OrderEffectResult }
  | { state: "not_committed" }
  | { state: "unknown" };

export interface OrderProviderLookupQuery {
  businessEffectKey?: string;
  externalOperationId?: string;
}

export interface OrderProvider {
  submitRefund(request: SubmitRefundRequest): Promise<OrderEffectResult>;
  submitCancel(request: SubmitCancelRequest): Promise<OrderEffectResult>;
  lookup(query: OrderProviderLookupQuery): Promise<OrderProviderLookupResult>;
}

/**
 * Fault injection for tests and evaluation only. Production composition never
 * passes faults; nothing here is read from the environment.
 */
export interface MockOrderProviderFaults {
  /** The provider rejects before anything is committed. */
  unavailableBeforeDispatch?: boolean;
  /** The response is lost or times out after dispatch; `committed` decides what a lookup finds. */
  afterDispatch?: { kind: "response_lost" | "timeout"; committed: boolean };
  /** Lookups cannot determine the outcome. */
  lookupIndeterminate?: boolean;
}

export interface MockOrderProviderOptions {
  fixture: SyntheticOrderFixture;
  faults?: MockOrderProviderFaults;
  now?: () => Date;
  createExternalOperationId?: () => string;
  /** Awaited after a submission is accepted and before it commits; lets tests hold a submission open. */
  beforeCommit?: (businessEffectKey: string) => Promise<void>;
}

interface OrderState {
  order: SyntheticOrder;
  status: SyntheticOrder["status"];
  refunded: Map<string, number>;
}

interface PreparedRefund {
  state: OrderState;
  quantities: ReadonlyMap<string, number>;
}

const REFUNDABLE_STATUSES: ReadonlySet<SyntheticOrder["status"]> = new Set(["delivered"]);
const CANCELLABLE_STATUSES: ReadonlySet<SyntheticOrder["status"]> = new Set(["placed", "processing"]);

/** In-memory mock of an external order system; state is lost on restart (design §13 Q3). */
export class MockOrderProvider implements OrderProvider {
  private readonly orders = new Map<string, OrderState>();
  private readonly effectsByKey = new Map<string, OrderEffectResult>();
  private readonly effectsByOperationId = new Map<string, OrderEffectResult>();
  private readonly faults: MockOrderProviderFaults;
  private readonly now: () => Date;
  private readonly createExternalOperationId: () => string;
  private readonly beforeCommit?: (businessEffectKey: string) => Promise<void>;
  private submissionCount = 0;
  private lookupCount = 0;

  constructor(options: MockOrderProviderOptions) {
    for (const order of options.fixture.orders) {
      this.orders.set(order.orderId, {
        order: structuredClone(order),
        status: order.status,
        refunded: new Map(),
      });
    }
    this.faults = { ...options.faults };
    this.now = options.now ?? (() => new Date());
    this.createExternalOperationId =
      options.createExternalOperationId ?? (() => `mock-order-op-${randomUUID()}`);
    this.beforeCommit = options.beforeCommit;
  }

  /** Every submission that reached the provider, committed or not. */
  get submissions(): number {
    return this.submissionCount;
  }

  get lookups(): number {
    return this.lookupCount;
  }

  async submitRefund(request: SubmitRefundRequest): Promise<OrderEffectResult> {
    return this.submit(request.businessEffectKey, "refund_request", request.orderId, () => {
      const prepared = this.prepareRefund(request);
      return () => {
        for (const [lineItemId, quantity] of prepared.quantities) {
          prepared.state.refunded.set(
            lineItemId,
            (prepared.state.refunded.get(lineItemId) ?? 0) + quantity
          );
        }
      };
    });
  }

  async submitCancel(request: SubmitCancelRequest): Promise<OrderEffectResult> {
    return this.submit(request.businessEffectKey, "cancel", request.orderId, () => {
      const state = this.ownedOrder(request.orderId, request.requester);
      if (!CANCELLABLE_STATUSES.has(state.status)) throw new OrderProviderError("ORDER_NOT_ELIGIBLE");
      return () => {
        state.status = "cancelled";
      };
    });
  }

  async lookup(query: OrderProviderLookupQuery): Promise<OrderProviderLookupResult> {
    this.lookupCount += 1;
    if (this.faults.lookupIndeterminate) return { state: "unknown" };
    const effect =
      (query.businessEffectKey !== undefined
        ? this.effectsByKey.get(query.businessEffectKey)
        : undefined) ??
      (query.externalOperationId !== undefined
        ? this.effectsByOperationId.get(query.externalOperationId)
        : undefined);
    return effect === undefined ? { state: "not_committed" } : { state: "committed", effect };
  }

  private async submit(
    businessEffectKey: string,
    kind: OrderEffectResult["kind"],
    orderId: string,
    validate: () => () => void
  ): Promise<OrderEffectResult> {
    this.submissionCount += 1;
    if (this.faults.unavailableBeforeDispatch) throw new OrderProviderError("ORDER_PROVIDER_UNAVAILABLE");
    if (this.effectsByKey.has(businessEffectKey)) {
      throw new OrderProviderError("ORDER_OPERATION_ALREADY_EXISTS");
    }
    validate();
    await this.beforeCommit?.(businessEffectKey);
    // Business rules are re-checked after the hold so the commit is atomic.
    if (this.effectsByKey.has(businessEffectKey)) {
      throw new OrderProviderError("ORDER_OPERATION_ALREADY_EXISTS");
    }
    const apply = validate();
    const fault = this.faults.afterDispatch;
    if (fault !== undefined && !fault.committed) {
      throw new OrderProviderError(
        fault.kind === "timeout" ? "ORDER_PROVIDER_TIMEOUT" : "ORDER_PROVIDER_RESPONSE_LOST"
      );
    }
    apply();
    const effect: OrderEffectResult = {
      schemaVersion: ORDER_EFFECT_RESULT_VERSION,
      kind,
      orderId,
      effect: "committed",
      externalOperationId: this.createExternalOperationId(),
      providerRecordedAt: this.now().toISOString(),
    };
    this.effectsByKey.set(businessEffectKey, effect);
    this.effectsByOperationId.set(effect.externalOperationId, effect);
    if (fault !== undefined) {
      throw new OrderProviderError(
        fault.kind === "timeout" ? "ORDER_PROVIDER_TIMEOUT" : "ORDER_PROVIDER_RESPONSE_LOST"
      );
    }
    return effect;
  }

  /** Another principal's or tenant's order is indistinguishable from a missing one. */
  private ownedOrder(orderId: string, requester: OrderRequester): OrderState {
    const state = this.orders.get(orderId);
    if (
      state === undefined ||
      state.order.tenantId !== requester.tenantId ||
      state.order.ownerPrincipalId !== requester.principalId
    ) {
      throw new OrderProviderError("ORDER_NOT_FOUND");
    }
    return state;
  }

  private prepareRefund(request: SubmitRefundRequest): PreparedRefund {
    const state = this.ownedOrder(request.orderId, request.requester);
    if (
      !REFUNDABLE_STATUSES.has(state.status) ||
      this.now().getTime() > Date.parse(state.order.refundWindowEndsAt)
    ) {
      throw new OrderProviderError("ORDER_NOT_ELIGIBLE");
    }
    const purchased = new Map(state.order.lineItems.map((item) => [item.lineItemId, item.quantity]));
    const requested = request.lineItems
      ? new Map(request.lineItems.map((item) => [item.lineItemId, item.quantity]))
      : new Map(
          [...purchased].map(([lineItemId, quantity]) => [
            lineItemId,
            quantity - (state.refunded.get(lineItemId) ?? 0),
          ])
        );
    let total = 0;
    for (const [lineItemId, quantity] of requested) {
      const bought = purchased.get(lineItemId);
      if (bought === undefined) throw new OrderProviderError("ORDER_NOT_ELIGIBLE");
      if (quantity > bought - (state.refunded.get(lineItemId) ?? 0)) {
        throw new OrderProviderError("ORDER_NOT_ELIGIBLE");
      }
      total += quantity;
    }
    if (total === 0) throw new OrderProviderError("ORDER_NOT_ELIGIBLE");
    return { state, quantities: new Map([...requested].filter(([, quantity]) => quantity > 0)) };
  }
}
