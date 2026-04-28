import {
  DEFAULT_NVIDIA_CHAT_MODELS,
  DEFAULT_NVIDIA_EMBEDDING_MODELS,
  DEFAULT_NVIDIA_PII_MODELS,
  DEFAULT_NVIDIA_SAFETY_MODELS,
  DEFAULT_NVIDIA_VISION_MODELS
} from "./nvidia-services.js";
import { DEFAULT_MODEL_ID } from "./model-catalog.js";

export type MeshTaskType =
  | "code"
  | "debug"
  | "review"
  | "retrieval"
  | "vision"
  | "security"
  | "runtime"
  | "planning"
  | "summarization";

export interface MeshModelRoute {
  taskType: MeshTaskType;
  confidence: number;
  primaryChatModel: string;
  chatFallbacks: string[];
  sidecarModel: string;
  retrievalModels: string[];
  visionModels: string[];
  safetyModels: string[];
  piiModels: string[];
  requiredGates: string[];
  rationale: string[];
}

const SIDE_ROLE_MODELS = [
  "microsoft/phi-4-mini-instruct",
  "nvidia/nemotron-mini-4b-instruct",
  "google/gemma-3-4b-it"
] as const;

export function routeMeshTask(input: string): MeshModelRoute {
  const normalized = input.toLowerCase();
  const taskType = inferTaskType(normalized);
  const requiredGates = requiredGatesFor(taskType, normalized);
  const rationale = rationaleFor(taskType);
  const primaryChatModel =
    taskType === "code" || taskType === "debug" || taskType === "review"
      ? DEFAULT_NVIDIA_CHAT_MODELS[0]
      : DEFAULT_MODEL_ID;

  return {
    taskType,
    confidence: confidenceFor(taskType, normalized),
    primaryChatModel,
    chatFallbacks: taskType === "code" || taskType === "debug" || taskType === "review"
      ? DEFAULT_NVIDIA_CHAT_MODELS.filter((model) => model !== primaryChatModel)
      : [DEFAULT_MODEL_ID],
    sidecarModel: SIDE_ROLE_MODELS[0],
    retrievalModels: [...DEFAULT_NVIDIA_EMBEDDING_MODELS],
    visionModels: [...DEFAULT_NVIDIA_VISION_MODELS],
    safetyModels: [...DEFAULT_NVIDIA_SAFETY_MODELS],
    piiModels: [...DEFAULT_NVIDIA_PII_MODELS],
    requiredGates,
    rationale
  };
}

function inferTaskType(input: string): MeshTaskType {
  if (/(screenshot|preview|visual|ui|frontend|css|layout|browser|inspect)/i.test(input)) return "vision";
  if (/(security|secret|token|pii|auth|vulnerability|xss|sqli|redos|guard|risk|risiko)/i.test(input)) return "security";
  if (/(crash|exception|stack|runtime|trace|sentry|otel|datadog|hologram|debug)/i.test(input)) return "debug";
  if (/(review|pr|pull request|diff|regression|test gap|audit)/i.test(input)) return "review";
  if (/(search|rag|retrieval|find|where|symbol|reference|architecture|explain)/i.test(input)) return "retrieval";
  if (/(plan|roadmap|design|architecture decision|adr)/i.test(input)) return "planning";
  if (/(summarize|summary|compress|distill|capsule)/i.test(input)) return "summarization";
  if (/(code|implement|fix|patch|refactor|build|test|typecheck)/i.test(input)) return "code";
  return "planning";
}

function confidenceFor(taskType: MeshTaskType, input: string): number {
  const strongSignals: Record<MeshTaskType, RegExp> = {
    code: /(implement|fix|patch|refactor|code|test|typecheck)/i,
    debug: /(crash|exception|stack|debug|runtime|sentry|trace)/i,
    review: /(review|pr|diff|regression|audit)/i,
    retrieval: /(rag|retrieval|search|symbol|reference|architecture)/i,
    vision: /(screenshot|preview|visual|ui|frontend|layout|inspect)/i,
    security: /(security|secret|token|pii|auth|vulnerability|sqli|redos)/i,
    runtime: /(runtime|trace|telemetry|production|sentry|otel)/i,
    planning: /(plan|roadmap|architecture|design|adr)/i,
    summarization: /(summarize|summary|compress|distill|capsule)/i
  };
  return strongSignals[taskType].test(input) ? 0.86 : 0.62;
}

function requiredGatesFor(taskType: MeshTaskType, input: string): string[] {
  const gates = new Set<string>(["retrieval_rerank", "proof_bundle"]);
  if (taskType === "code" || taskType === "debug" || /patch|fix|refactor|implement/i.test(input)) {
    gates.add("timeline_verification");
    gates.add("precrime_gate");
  }
  if (taskType === "vision") {
    gates.add("vision_regression_check");
  }
  if (taskType === "security" || /(auth|secret|token|pii|runtime|shell|exec)/i.test(input)) {
    gates.add("safety_guard");
    gates.add("pii_scan");
  }
  if (taskType === "review") {
    gates.add("diff_review");
    gates.add("test_gap_check");
  }
  return Array.from(gates);
}

function rationaleFor(taskType: MeshTaskType): string[] {
  const shared = ["Use code-specific embeddings for repository context before raw file reads."];
  if (taskType === "vision") return ["Use a vision model for screenshot evidence.", ...shared];
  if (taskType === "security") return ["Run safety and PII specialists before persisting or promoting risky artifacts.", ...shared];
  if (taskType === "debug") return ["Pair runtime evidence with timeline-first fixes.", ...shared];
  if (taskType === "review") return ["Require proof, test-gap, and risk checks before merge.", ...shared];
  if (taskType === "code") return ["Use the strongest code model for candidate changes and verify in timelines.", ...shared];
  return shared;
}
