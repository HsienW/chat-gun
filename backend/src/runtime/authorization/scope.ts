export { SCOPE_TYPES } from "@gun-ai/harness-contracts";
export type {
  PrincipalScopeIdentity,
  ProjectedTrustedScope,
  RuntimeScope,
  ScopeType,
  StoredScopeIdentity,
  TrustedScopeProjection,
} from "@gun-ai/harness-contracts";
export {
  isActiveScopePresent,
  isScopeCompatible,
  projectTrustedScope,
  scopeTenantMatches,
} from "@gun-ai/harness-kernel";
