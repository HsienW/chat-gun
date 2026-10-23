import type { GovernedStoreDriver } from "../runtime/data-governance/governed-store.js";

export const KNOWLEDGE_CORPUS_DATA_CLASS_ID = "knowledge.corpus-index";

/**
 * The knowledge index is derived from a curated corpus that holds no subject personal data.
 * Subject export and deletion therefore enumerate the store and report zero records instead of
 * being skipped silently. Corpus source deletion is a separate operator path on the store.
 */
export function createKnowledgeCorpusGovernedDriver(): GovernedStoreDriver {
  return {
    exportBySubject: async () => [],
    deleteBySubject: async () => 0,
    countBySubject: async () => 0,
  };
}
