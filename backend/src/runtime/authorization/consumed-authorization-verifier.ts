import type { ExecutionContext } from "../execution-context/execution-context.js";
import type { Queryable } from "../persistence/rows.js";

export interface VerifyConsumedAuthorizationInput {
  decisionId: string;
  toolName: string;
  executionContext: ExecutionContext;
}

/**
 * Confirms that a decision handed to a pre-authorized dispatch is a real,
 * positive server-side decision for this principal, scope, tool and call.
 * Graph state can be rewritten by a client, so the decision identifier alone
 * is never trusted.
 */
export interface ConsumedAuthorizationVerifier {
  verify(input: VerifyConsumedAuthorizationInput): Promise<boolean>;
}

interface ConsumedAuthorizationRow extends Record<string, unknown> {
  effect: string;
  principal_id: string;
  tenant_id: string;
  scope_id: string;
  decision_tool_name: string | null;
  confirmation_status: string | null;
  confirmation_consumed_at: string | Date | null;
  confirmation_tool_name: string | null;
  confirmation_tool_call_id: string | null;
}

export class PgConsumedAuthorizationVerifier
  implements ConsumedAuthorizationVerifier
{
  constructor(private readonly db: Queryable) {}

  async verify(input: VerifyConsumedAuthorizationInput): Promise<boolean> {
    let row: ConsumedAuthorizationRow | undefined;
    try {
      const result = await this.db.query<ConsumedAuthorizationRow>(
        `SELECT pd.effect, pd.principal_id, pd.tenant_id, pd.scope_id,
                pd.context_summary ->> 'toolName' AS decision_tool_name,
                ac.status AS confirmation_status,
                ac.consumed_at AS confirmation_consumed_at,
                ac.descriptor -> 'summary' ->> 'toolName' AS confirmation_tool_name,
                ac.descriptor ->> 'toolCallId' AS confirmation_tool_call_id
         FROM permission_decisions pd
         LEFT JOIN authorization_confirmations ac
           ON ac.decision_id = pd.decision_id
         WHERE pd.decision_id = $1`,
        [input.decisionId]
      );
      row = result.rows[0];
    } catch {
      return false;
    }
    if (!row) return false;

    const context = input.executionContext;
    if (
      row.effect !== "allow" ||
      row.principal_id !== context.principal.principalId ||
      row.tenant_id !== context.scope.tenantId ||
      row.scope_id !== context.scope.scopeId
    ) {
      return false;
    }

    if (row.confirmation_status === null) {
      // A direct allow: the recorded decision must belong to this tool.
      return row.decision_tool_name === input.toolName;
    }
    return (
      row.confirmation_status === "approved" &&
      row.confirmation_consumed_at !== null &&
      row.confirmation_tool_name === input.toolName &&
      context.toolCallId !== undefined &&
      row.confirmation_tool_call_id === context.toolCallId
    );
  }
}
