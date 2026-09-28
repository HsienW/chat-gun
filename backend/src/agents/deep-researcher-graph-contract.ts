import { createExecutionManifestRef } from "../runtime/recovery/execution-manifest.js";

export const DEEP_RESEARCH_GRAPH_NODES = {
  validateUploads: "validate_uploads",
  buildContextPack: "build_context_pack",
  analyzeImages: "analyze_images",
  planResearch: "plan_research",
  targetedTools: "targeted_tools",
  clarifyInterrupt: "clarify_interrupt",
  resumeClarify: "resume_clarify",
  searchWeb: "search_web",
  rankSources: "rank_sources",
  fetchSources: "fetch_sources",
  extractEvidence: "extract_evidence",
  verifyCitations: "verify_citations",
  synthesizeAnswer: "synthesize_answer",
} as const;

export const DEEP_RESEARCH_GRAPH_ROUTES = {
  buildContextPack: "build_context_pack",
  analyzeImages: "analyze_images",
  targetedTools: "targeted_tools",
  clarifyInterrupt: "clarify_interrupt",
  resumeClarify: "resume_clarify",
  searchWeb: "search_web",
  synthesize: "synthesize",
  rank: "rank",
  fetch: "fetch",
  verify: "verify",
} as const;

export const deepResearcherExecutionManifest = createExecutionManifestRef({
  graphId: "deep_researcher",
  graphConfig: {
    nodes: DEEP_RESEARCH_GRAPH_NODES,
    routes: DEEP_RESEARCH_GRAPH_ROUTES,
    checkpointer: "memory_saver",
  },
});
