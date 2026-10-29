import type { Queryable } from "../../runtime/persistence/rows.js";

export interface OriginalOperationQuery {
  businessEffectId: string;
  tenantId: string;
  scopeId: string;
  principalId: string;
}

/** Finds the approval that holds or completed a business effect; null outside the requester's tenant, scope and principal. */
export interface OriginalOperationResolver {
  resolveApprovalId(query: OriginalOperationQuery): Promise<string | null>;
}

interface ApprovalRow extends Record<string, unknown> {
  approval_id: unknown;
}

/** Without a runtime database nothing can be resolved; the card then leaves `dedup.of` out. */
export const unresolvableOriginalOperation: OriginalOperationResolver = {
  resolveApprovalId: async () => null,
};

/** Read-only: follows the existing decision link from the ledger to the approval record (design §6.5, §6.7). */
export class PgOriginalOperationResolver implements OriginalOperationResolver {
  constructor(private readonly db: Queryable) {}

  async resolveApprovalId(query: OriginalOperationQuery): Promise<string | null> {
    const result = await this.db.query<ApprovalRow>(
      // The original is the latest submission that claimed the effect: the one
      // holding or having committed it. An earlier attempt released before a
      // reclaim is not, and a holder not yet linked to its decision resolves to none.
      `SELECT c.approval_id
         FROM (
           SELECT decision_id
             FROM tool_executions
            WHERE business_effect_id = $1
              -- Deduplicated submissions also carry their own decision; they are never the original.
              AND termination_cause IS DISTINCT FROM 'deduplicated'
            ORDER BY created_at DESC, tool_execution_id DESC
            LIMIT 1
         ) e
         JOIN authorization_confirmations c ON c.decision_id = e.decision_id
        WHERE c.tenant_id = $2
          AND c.scope_id = $3
          AND $4 = ANY(c.principal_ids)`,
      [query.businessEffectId, query.tenantId, query.scopeId, query.principalId]
    );
    const approvalId = result.rows[0]?.approval_id;
    return typeof approvalId === "string" && approvalId.length > 0 ? approvalId : null;
  }
}
