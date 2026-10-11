import ts from "typescript";

import { EXECUTION_PROFILE_ENFORCEMENT_MARKER } from "../runtime/tool-dispatch/execution-profile.js";

export const ARCHITECTURE_CHECK_IDS = [
  "profile-missing-dispatch",
  "egress-bypass",
  "secret-into-context",
  "direct-protected-tool-invocation",
  "mutation-descriptor-missing",
  "production-registry-authorization-missing",
  "unversioned-runtime-event-producer",
  "agent-legacy-context-assembly",
  "client-controlled-trusted-identity",
  "harness-forbidden-dependency",
  "harness-cycle",
  "chat-gun-parallel-local-definition",
] as const;

export type ArchitectureCheckId = (typeof ARCHITECTURE_CHECK_IDS)[number];

export interface ArchitectureSource {
  path: string;
  source: string;
}

export interface ArchitectureFinding {
  checkId: ArchitectureCheckId;
  path: string;
  reasonCode: string;
}

export interface ArchitectureOverrideAudit {
  checkId: string;
  reasonCode: string;
  expiry?: string;
  outcome: "applied" | "expired" | "invalid" | "unused";
}

export interface ArchitectureCheckResult {
  status: "passed" | "failed";
  findings: ArchitectureFinding[];
  overrideAudit: ArchitectureOverrideAudit[];
}

interface ParsedOverride {
  checkId: ArchitectureCheckId;
  reasonCode: string;
  expiry: string;
}

const HARNESS_PACKAGE_NAMES = [
  "@gun-ai/harness-contracts",
  "@gun-ai/harness-kernel",
  "@gun-ai/harness-testkit",
] as const;

type HarnessPackageName = (typeof HARNESS_PACKAGE_NAMES)[number];

interface ParsedArchitectureSource extends ArchitectureSource {
  declaredSymbols: ReadonlySet<string>;
  harnessPackage?: HarnessPackageName;
  importedContractSymbols: ReadonlySet<string>;
  moduleSpecifiers: readonly string[];
}

const HARNESS_ALLOWED_DEPENDENCIES: Readonly<
  Record<HarnessPackageName, ReadonlySet<HarnessPackageName>>
> = {
  "@gun-ai/harness-contracts": new Set(),
  "@gun-ai/harness-kernel": new Set(["@gun-ai/harness-contracts"]),
  "@gun-ai/harness-testkit": new Set([
    "@gun-ai/harness-contracts",
    "@gun-ai/harness-kernel",
  ]),
};

const FORBIDDEN_HARNESS_DEPENDENCIES = [
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@langchain",
  "@modelcontextprotocol",
  "chat-gun",
  "express",
  "ioredis",
  "langchain",
  "openai",
  "pg",
  "react",
  "react-dom",
] as const;

const MAX_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1_000;
const MACHINE_IDENTIFIER = /^[a-z][a-z0-9-]{2,63}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function harnessPackageFromSpecifier(
  moduleSpecifier: string
): HarnessPackageName | undefined {
  return HARNESS_PACKAGE_NAMES.find(
    (packageName) =>
      moduleSpecifier === packageName ||
      moduleSpecifier.startsWith(`${packageName}/`)
  );
}

function harnessPackageFromPath(path: string): HarnessPackageName | undefined {
  const normalizedPath = path.replaceAll("\\", "/");
  const scopedMatch = /(?:^|\/)@gun-ai\/harness-(contracts|kernel|testkit)(?:\/|$)/u.exec(
    normalizedPath
  );
  const packageMatch = /(?:^|\/)packages\/(contracts|kernel|testkit)(?:\/|$)/u.exec(
    normalizedPath
  );
  const packageSegment = scopedMatch?.[1] ?? packageMatch?.[1];
  return packageSegment === undefined
    ? undefined
    : (`@gun-ai/harness-${packageSegment}` as HarnessPackageName);
}

function moduleName(node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
  return node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : undefined;
}

function collectDeclaredBindingNames(
  name: ts.BindingName,
  declaredSymbols: Set<string>
): void {
  if (ts.isIdentifier(name)) {
    declaredSymbols.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectDeclaredBindingNames(element.name, declaredSymbols);
    }
  }
}

function parseArchitectureSource(source: ArchitectureSource): ParsedArchitectureSource {
  const sourceFile = ts.createSourceFile(
    source.path,
    source.source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  const declaredSymbols = new Set<string>();
  const importedContractSymbols = new Set<string>();
  const moduleSpecifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const specifier = moduleName(statement);
      if (specifier !== undefined) moduleSpecifiers.push(specifier);
    }
    if (
      ts.isImportDeclaration(statement) &&
      harnessPackageFromSpecifier(moduleName(statement) ?? "") ===
        "@gun-ai/harness-contracts" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        importedContractSymbols.add((element.propertyName ?? element.name).text);
      }
    }
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isFunctionDeclaration(statement)
    ) {
      if (statement.name !== undefined) declaredSymbols.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectDeclaredBindingNames(declaration.name, declaredSymbols);
      }
    }
  }

  const harnessPackage = harnessPackageFromPath(source.path);
  return {
    ...source,
    ...(harnessPackage === undefined ? {} : { harnessPackage }),
    declaredSymbols,
    importedContractSymbols,
    moduleSpecifiers,
  };
}

function isForbiddenHarnessDependency(
  owner: HarnessPackageName,
  moduleSpecifier: string
): boolean {
  const harnessDependency = harnessPackageFromSpecifier(moduleSpecifier);
  if (harnessDependency !== undefined) {
    return (
      harnessDependency !== owner &&
      !HARNESS_ALLOWED_DEPENDENCIES[owner].has(harnessDependency)
    );
  }
  if (moduleSpecifier.startsWith(".")) {
    const pathSegments = moduleSpecifier.replaceAll("\\", "/").split("/");
    return pathSegments.some((segment) =>
      ["backend", "bff", "frontend", "chat-gun"].includes(segment)
    );
  }
  return FORBIDDEN_HARNESS_DEPENDENCIES.some(
    (dependency) =>
      moduleSpecifier === dependency ||
      moduleSpecifier.startsWith(`${dependency}/`)
  );
}

function packageParticipatesInCycle(
  packageName: HarnessPackageName,
  packageDependencies: ReadonlyMap<HarnessPackageName, ReadonlySet<HarnessPackageName>>
): boolean {
  const visit = (
    current: HarnessPackageName,
    visited: ReadonlySet<HarnessPackageName>
  ): boolean => {
    for (const dependency of packageDependencies.get(current) ?? []) {
      if (dependency === packageName) return true;
      if (visited.has(dependency)) continue;
      const nextVisited = new Set(visited);
      nextVisited.add(dependency);
      if (visit(dependency, nextVisited)) return true;
    }
    return false;
  };
  return visit(packageName, new Set([packageName]));
}

function runHarnessProjectChecks(
  sources: readonly ArchitectureSource[]
): ArchitectureFinding[] {
  const parsedSources = sources.map(parseArchitectureSource);
  const findings: ArchitectureFinding[] = [];

  for (const source of parsedSources) {
    const harnessPackage = source.harnessPackage;
    if (
      harnessPackage !== undefined &&
      source.moduleSpecifiers.some((moduleSpecifier) =>
        isForbiddenHarnessDependency(harnessPackage, moduleSpecifier)
      )
    ) {
      findings.push({
        checkId: "harness-forbidden-dependency",
        path: source.path,
        reasonCode: "HARNESS_FORBIDDEN_DEPENDENCY",
      });
    }
  }

  const packageDependencies = new Map<
    HarnessPackageName,
    Set<HarnessPackageName>
  >();
  for (const source of parsedSources) {
    if (source.harnessPackage === undefined) continue;
    const dependencies = packageDependencies.get(source.harnessPackage) ?? new Set();
    for (const moduleSpecifier of source.moduleSpecifiers) {
      const dependency = harnessPackageFromSpecifier(moduleSpecifier);
      if (dependency !== undefined) dependencies.add(dependency);
    }
    packageDependencies.set(source.harnessPackage, dependencies);
  }
  const cyclePackages = new Set(
    HARNESS_PACKAGE_NAMES.filter((packageName) =>
      packageParticipatesInCycle(packageName, packageDependencies)
    )
  );
  for (const source of parsedSources) {
    if (source.harnessPackage !== undefined && cyclePackages.has(source.harnessPackage)) {
      findings.push({
        checkId: "harness-cycle",
        path: source.path,
        reasonCode: "HARNESS_PACKAGE_CYCLE",
      });
    }
  }

  const consumedContractSymbols = new Set(
    parsedSources
      .filter((source) => source.harnessPackage === undefined)
      .flatMap((source) => [...source.importedContractSymbols])
  );
  for (const source of parsedSources) {
    if (source.harnessPackage !== undefined) continue;
    const parallelSymbols = [...source.declaredSymbols].filter((symbolName) =>
      consumedContractSymbols.has(symbolName)
    );
    if (parallelSymbols.length > 0) {
      findings.push({
        checkId: "chat-gun-parallel-local-definition",
        path: source.path,
        reasonCode: "CHAT_GUN_PARALLEL_LOCAL_DEFINITION",
      });
    }
  }

  return findings;
}

function hasObjectWithoutField(
  source: string,
  discriminator: RegExp,
  requiredField: RegExp
): boolean {
  const objects = source.match(/\{[^{}]{0,2000}\}/gs) ?? [];
  return objects.some(
    (candidate) => discriminator.test(candidate) && !requiredField.test(candidate)
  );
}

const CHECKS: ReadonlyArray<{
  checkId: ArchitectureCheckId;
  reasonCode: string;
  detects(source: string, runtimeSymbols: readonly symbol[]): boolean;
}> = [
  {
    checkId: "profile-missing-dispatch",
    reasonCode: "PROFILE_MISSING_DISPATCH",
    detects: (source, runtimeSymbols) =>
      /\bsourceTool\s*\.\s*invoke\s*\(/u.test(source) &&
      (!/\bexecutionProfileEnforcer\s*\??\s*\.\s*enforce\s*\(/u.test(source) ||
        !runtimeSymbols.includes(EXECUTION_PROFILE_ENFORCEMENT_MARKER)),
  },
  {
    checkId: "egress-bypass",
    reasonCode: "EGRESS_BYPASS",
    detects: (source) =>
      /\bfetch\s*\(/u.test(source) &&
      !/\bfetchWithValidatedRedirects\s*\(/u.test(source),
  },
  {
    checkId: "secret-into-context",
    reasonCode: "SECRET_INTO_CONTEXT",
    detects: (source) =>
      /\b(?:configurable|metadata)\s*\.\s*(?:apiKey|credential|password|secret|token)\b/iu.test(
        source
      ) ||
      /\bgetEnv\s*\(\s*["'](?:BRAVE_API_KEY|TAVILY_API_KEY)["']/u.test(source),
  },
  {
    checkId: "direct-protected-tool-invocation",
    reasonCode: "DIRECT_PROTECTED_TOOL_INVOCATION",
    detects: (source) => /\bprotectedTool\s*\.\s*invoke\s*\(/u.test(source),
  },
  {
    checkId: "mutation-descriptor-missing",
    reasonCode: "MUTATION_DESCRIPTOR_MISSING",
    detects: (source) =>
      hasObjectWithoutField(source, /\bisReadOnly\s*:\s*false\b/u, /\bsideEffect\s*:/u),
  },
  {
    checkId: "production-registry-authorization-missing",
    reasonCode: "PRODUCTION_REGISTRY_AUTHORIZATION_MISSING",
    detects: (source) =>
      /\bcreateProductionRegistry\s*\(\s*\{[^}]*\bauthorization\s*:\s*(?:undefined|null)\b/su.test(
        source
      ),
  },
  {
    checkId: "unversioned-runtime-event-producer",
    reasonCode: "UNVERSIONED_RUNTIME_EVENT_PRODUCER",
    detects: (source) =>
      hasObjectWithoutField(
        source,
        /\b(?:emitRuntimeEvent|runtimeEvent)\s*:/u,
        /\b(?:schemaVersion|eventVersion)\s*:/u
      ),
  },
  {
    checkId: "agent-legacy-context-assembly",
    reasonCode: "AGENT_LEGACY_CONTEXT_ASSEMBLY",
    detects: (source) => /\bbuildConversationContext\s*\(/u.test(source),
  },
  {
    checkId: "client-controlled-trusted-identity",
    reasonCode: "CLIENT_CONTROLLED_TRUSTED_IDENTITY",
    detects: (source) =>
      /\b(?:configurable|metadata)\s*\.\s*(?:principal|principalId|tenantId|userId)\b/u.test(
        source
      ),
  },
];

function parseOverride(
  raw: string,
  nowMs: number
): { override?: ParsedOverride; audit?: ArchitectureOverrideAudit } {
  const firstSeparator = raw.indexOf(":");
  const secondSeparator = raw.indexOf(":", firstSeparator + 1);
  const checkId = raw.slice(0, firstSeparator);
  const reasonCode = raw.slice(firstSeparator + 1, secondSeparator);
  const expiry = raw.slice(secondSeparator + 1);
  const parsedExpiry = Date.parse(expiry ?? "");
  if (
    firstSeparator <= 0 ||
    secondSeparator <= firstSeparator + 1 ||
    !ARCHITECTURE_CHECK_IDS.includes(checkId as ArchitectureCheckId) ||
    !MACHINE_IDENTIFIER.test(checkId ?? "") ||
    !REASON_CODE.test(reasonCode ?? "") ||
    !Number.isFinite(parsedExpiry)
  ) {
    return {
      audit: {
        checkId: checkId ?? "invalid",
        reasonCode: reasonCode ?? "INVALID_OVERRIDE",
        ...(expiry ? { expiry } : {}),
        outcome: "invalid",
      },
    };
  }
  if (parsedExpiry <= nowMs) {
    return {
      audit: { checkId, reasonCode, expiry, outcome: "expired" },
    };
  }
  if (parsedExpiry - nowMs > MAX_OVERRIDE_TTL_MS) {
    return {
      audit: { checkId, reasonCode, expiry, outcome: "invalid" },
    };
  }
  return {
    override: {
      checkId: checkId as ArchitectureCheckId,
      reasonCode,
      expiry,
    },
  };
}

export function runArchitectureChecks(input: {
  sources: readonly ArchitectureSource[];
  runtimeSymbols?: readonly symbol[];
  overrideConfig?: string;
  now?: Date;
}): ArchitectureCheckResult {
  const findings = [
    ...input.sources.flatMap(({ path, source }) =>
      CHECKS.filter((check) =>
        check.detects(source, input.runtimeSymbols ?? [])
      ).map((check) => ({
        checkId: check.checkId,
        path,
        reasonCode: check.reasonCode,
      }))
    ),
    ...runHarnessProjectChecks(input.sources),
  ];
  const nowMs = (input.now ?? new Date()).getTime();
  const overrideAudit: ArchitectureOverrideAudit[] = [];
  const overrides = new Map<ArchitectureCheckId, ParsedOverride>();

  for (const raw of (input.overrideConfig ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const parsed = parseOverride(raw, nowMs);
    if (parsed.audit) overrideAudit.push(parsed.audit);
    if (parsed.override) overrides.set(parsed.override.checkId, parsed.override);
  }

  const activeFindings = findings.filter((finding) => {
    const override = overrides.get(finding.checkId);
    if (!override) return true;
    overrideAudit.push({
      checkId: override.checkId,
      reasonCode: override.reasonCode,
      expiry: override.expiry,
      outcome: "applied",
    });
    overrides.delete(finding.checkId);
    return false;
  });

  for (const override of overrides.values()) {
    overrideAudit.push({
      checkId: override.checkId,
      reasonCode: override.reasonCode,
      expiry: override.expiry,
      outcome: "unused",
    });
  }

  return {
    status:
      activeFindings.length === 0 &&
      overrideAudit.every((entry) => entry.outcome !== "invalid" && entry.outcome !== "expired")
        ? "passed"
        : "failed",
    findings: activeFindings,
    overrideAudit,
  };
}
