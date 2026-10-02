import type { Queryable } from "../persistence/rows.js";
import { ConsentService, PgConsentRecordStore } from "./consent.js";
import {
  GovernedStoreAdapter,
  createUnavailableGovernedStoreDriver,
  type GovernedStoreDriver,
} from "./governed-store.js";
import {
  HttpIdentityGovernedStore,
  type HttpIdentityGovernedStoreOptions,
} from "./identity-http-governed-store.js";
import {
  PgGovernedStoreDriver,
  createDefaultPgGovernedPlans,
} from "./pg-governed-store-driver.js";
import {
  DataInventoryRegistry,
  createDefaultInventoryEntries,
} from "./registry.js";
import {
  PgSubjectRightWorkflowRepository,
  SubjectRightWorkflowService,
} from "./subject-right-workflow.js";
import {
  InMemoryTombstoneCache,
  PgTombstoneRepository,
  TombstoneService,
  type TombstoneCache,
} from "./tombstone.js";

export type DataGovernanceRuntimeOptions = {
  database: Queryable;
  identityHttp: HttpIdentityGovernedStoreOptions;
  externalDrivers: ReadonlyMap<string, GovernedStoreDriver>;
  tombstoneCache?: TombstoneCache;
  activeRecordTtlSeconds: number;
  tombstoneTtlSeconds: number;
};

export function createDataGovernanceRuntime(options: DataGovernanceRuntimeOptions) {
  const entries = createDefaultInventoryEntries();
  const registry = new DataInventoryRegistry();
  const pgDriver = new PgGovernedStoreDriver(
    options.database,
    createDefaultPgGovernedPlans(entries),
  );
  const unavailableExternalDriver = createUnavailableGovernedStoreDriver();

  for (const entry of entries) {
    if (entry.dataClassId.startsWith("identity.")) {
      registry.register(entry, new HttpIdentityGovernedStore(entry, options.identityHttp));
      continue;
    }
    if (entry.authoritativeStore.startsWith("postgres.")) {
      registry.register(entry, new GovernedStoreAdapter(entry, pgDriver));
      continue;
    }
    const driver =
      options.externalDrivers.get(entry.dataClassId) ?? unavailableExternalDriver;
    registry.register(entry, new GovernedStoreAdapter(entry, driver));
  }

  const workflowRepository = new PgSubjectRightWorkflowRepository(options.database);
  return {
    registry,
    workflows: new SubjectRightWorkflowService(registry, workflowRepository),
    consent: new ConsentService(new PgConsentRecordStore(options.database)),
    tombstones: new TombstoneService(
      new PgTombstoneRepository(options.database),
      options.tombstoneCache ?? new InMemoryTombstoneCache(),
      {
        activeRecordTtlSeconds: options.activeRecordTtlSeconds,
        tombstoneTtlSeconds: options.tombstoneTtlSeconds,
      },
    ),
  };
}
