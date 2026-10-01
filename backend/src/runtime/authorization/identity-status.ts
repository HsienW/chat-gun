import {
  accountStatusSchema,
  sessionStatusSchema,
  type AccountStatus,
  type SessionStatus,
} from "./consumer-identity.js";
import type { ExecutionContext } from "../execution-context/execution-context.js";

export type AccountStatusCheck = { status: AccountStatus | "not_found" };
export type SessionStatusCheck = { status: SessionStatus | "not_found" };

export interface RuntimeIdentityStatusPort {
  checkAccount(accountId: string): Promise<AccountStatusCheck>;
  checkSession(
    sessionId: string,
    accountId: string,
    principalId: string,
  ): Promise<SessionStatusCheck>;
}

export interface ReadOnlyPgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export class PgRuntimeIdentityStatusPort implements RuntimeIdentityStatusPort {
  constructor(private readonly database: ReadOnlyPgQueryable) {}

  async checkAccount(accountId: string): Promise<AccountStatusCheck> {
    const result = await this.database.query<{ status: unknown }>(
      "SELECT status FROM identity_accounts WHERE account_id = $1",
      [accountId],
    );
    const status = result.rows[0]?.status;
    if (status === undefined) return { status: "not_found" };
    const parsed = accountStatusSchema.safeParse(status);
    if (!parsed.success) throw statusError("IDENTITY_STATUS_INVALID");
    return { status: parsed.data };
  }

  async checkSession(
    sessionId: string,
    accountId: string,
    principalId: string,
  ): Promise<SessionStatusCheck> {
    const result = await this.database.query<{ status: unknown }>(
      "SELECT status FROM identity_sessions WHERE session_id = $1 AND account_id = $2 AND principal_id = $3",
      [sessionId, accountId, principalId],
    );
    const status = result.rows[0]?.status;
    if (status === undefined) return { status: "not_found" };
    const parsed = sessionStatusSchema.safeParse(status);
    if (!parsed.success) throw statusError("IDENTITY_STATUS_INVALID");
    return { status: parsed.data };
  }
}

function statusError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  Object.defineProperty(error, "code", { enumerable: true, value: code });
  return error;
}

export async function enforceRuntimeIdentityStatus(
  context: ExecutionContext,
  options: {
    enabled: boolean;
    protectedPath: boolean;
    port: RuntimeIdentityStatusPort;
  },
): Promise<void> {
  if (!options.enabled) return;
  if (!context.accountId || !context.sessionId) {
    if (options.protectedPath) throw statusError("IDENTITY_CONTEXT_REQUIRED");
    return;
  }
  let account: AccountStatusCheck;
  let session: SessionStatusCheck;
  try {
    [account, session] = await Promise.all([
      options.port.checkAccount(context.accountId),
      options.port.checkSession(
        context.sessionId,
        context.accountId,
        context.principal.principalId,
      ),
    ]);
  } catch {
    throw statusError("IDENTITY_STATUS_UNAVAILABLE");
  }
  if (account.status !== "active") throw statusError("IDENTITY_ACCOUNT_DENIED");
  if (session.status !== "active") throw statusError("IDENTITY_SESSION_DENIED");
}
