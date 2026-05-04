/**
 * Shared Feature Engines Barrel Export
 * Wave 1: RAG, Impact Analysis, Timelines
 * Wave 2: Runtime Debugging, Capsules, Basic Tools
 */

export * from "./types.js";

// Wave 1 engines
export { RAGEngine } from "./rag-engine.js";
export { TimelineManager } from "./timeline-manager.js";
export { ImpactAnalyzer } from "./impact-analyzer.js";

// Wave 2 engines
export { RuntimeObserver } from "./runtime-observer.js";
export { SessionCapsuleStore } from "./capsule-store.js";
export { WorkspaceTools } from "./workspace-tools.js";
