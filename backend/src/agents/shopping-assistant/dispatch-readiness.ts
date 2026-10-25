import type { Queryable } from "../../runtime/persistence/rows.js";

/**
 * Read-only preflight before an approval is created (design §6.1): the
 * side-effect ledger and the approval store must both answer. The dispatch
 * pipeline itself is always built for the shopping runtime, and the ledger
 * still fails closed at dispatch; this check never replaces that one.
 */
export function createDispatchReadinessCheck(db: Queryable | null | undefined): () => Promise<boolean> {
  if (!db) return async () => false;
  return async () => {
    try {
      await db.query("SELECT 1 FROM business_effects LIMIT 0");
      await db.query("SELECT 1 FROM authorization_confirmations LIMIT 0");
      return true;
    } catch {
      return false;
    }
  };
}
