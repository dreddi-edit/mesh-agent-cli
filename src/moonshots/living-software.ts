import path from "node:path";
import { readJson, writeJson } from "./common.js";

export class LivingSoftwareEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "pulse").trim().toLowerCase();
    if (action === "status") return this.status();
    if (action !== "pulse") throw new Error("workspace.living_software action must be pulse|status");
    const inputs = await this.readSubsystems();
    const scores = score(inputs);
    const pulse = {
      ok: true,
      action,
      generatedAt: new Date().toISOString(),
      scores,
      organismState: classify(scores),
      signals: summarizeInputs(inputs),
      nextInterventions: nextInterventions(inputs),
      pulsePath: ".mesh/living-software/pulse.json"
    };
    await writeJson(this.pulsePath(), pulse);
    return pulse;
  }

  private async status(): Promise<Record<string, unknown>> {
    return readJson(this.pulsePath(), {
      ok: true,
      action: "status",
      message: "No living-software pulse exists yet. Run action=pulse."
    });
  }

  private async readSubsystems(): Promise<Record<string, any>> {
    return {
      selfDefense: await readJson(path.join(this.workspaceRoot, ".mesh", "security", "last-self-defense.json"), null),
      precrime: await readJson(path.join(this.workspaceRoot, ".mesh", "precrime", "predictions.json"), null),
      shadowDeploy: await readJson(path.join(this.workspaceRoot, ".mesh", "shadow-deploy", "last-ledger.json"), null),
      semanticGit: await readJson(path.join(this.workspaceRoot, ".mesh", "semantic-git", "last-analysis.json"), null),
      probabilistic: await readJson(path.join(this.workspaceRoot, ".mesh", "probabilistic", "experiments.json"), null),
      specCode: await readJson(path.join(this.workspaceRoot, ".mesh", "spec-code", "contracts.json"), null),
      conversations: await readJson(path.join(this.workspaceRoot, ".mesh", "conversations", "symbol-memory.json"), null),
      fluidMesh: await readJson(path.join(this.workspaceRoot, ".mesh", "fluid-mesh", "capabilities.json"), null),
      naturalLanguage: await readJson(path.join(this.workspaceRoot, ".mesh", "natural-language-source", "last-compile.json"), null),
      proofCarryingChange: await readJson(path.join(this.workspaceRoot, ".mesh", "proof-carrying-change", "proof.json"), null),
      causalAutopsy: await readJson(path.join(this.workspaceRoot, ".mesh", "causal-autopsy", "last-autopsy.json"), null)
    };
  }

  private pulsePath(): string {
    return path.join(this.workspaceRoot, ".mesh", "living-software", "pulse.json");
  }
}

function score(inputs: Record<string, any>): Record<string, number> {
  const immune = inputs.selfDefense?.confirmed ? Math.min(100, 50 + inputs.selfDefense.confirmed * 10) : inputs.selfDefense ? 55 : 20;
  const predictive = inputs.precrime?.predictions ? Math.min(100, 40 + inputs.precrime.predictions.length * 4) : 20;
  const adaptive = inputs.probabilistic?.experiments ? Math.min(100, 35 + inputs.probabilistic.experiments.length * 3) : 20;
  const memory = inputs.conversations?.symbols ? Math.min(100, 30 + inputs.conversations.symbols.length) : 15;
  const deployConfidence = inputs.shadowDeploy?.ok === true ? 80 : inputs.shadowDeploy ? 35 : 20;
  const specIntegrity = inputs.specCode?.summary ? Math.max(10, 85 - (inputs.specCode.summary.driftItems ?? 0) * 8) : 20;
  const capabilityFluidity = inputs.fluidMesh?.capabilities ? Math.min(100, 30 + inputs.fluidMesh.capabilities.length) : 20;
  const languageReadiness = inputs.naturalLanguage?.ir ? 75 : 20;
  const proofReadiness = inputs.proofCarryingChange?.verdict
    ? inputs.proofCarryingChange.verdict === "ready_to_promote" ? 90 : inputs.proofCarryingChange.verdict === "blocked" ? 25 : 65
    : 20;
  const causalClarity = inputs.causalAutopsy?.suspects
    ? Math.min(95, 35 + inputs.causalAutopsy.suspects.length * 6)
    : 20;
  return {
    immune,
    predictive,
    adaptive,
    memory,
    deployConfidence,
    specIntegrity,
    capabilityFluidity,
    languageReadiness,
    proofReadiness,
    causalClarity
  };
}

function classify(scores: Record<string, number>): string {
  const avg = Object.values(scores).reduce((sum, value) => sum + value, 0) / Math.max(1, Object.keys(scores).length);
  if (avg >= 75) return "self-maintaining";
  if (avg >= 50) return "learning";
  return "embryonic";
}

function summarizeInputs(inputs: Record<string, any>): Record<string, unknown> {
  return {
    selfDefenseFindings: inputs.selfDefense?.suspicious ?? 0,
    precrimePredictions: inputs.precrime?.predictions?.length ?? 0,
    shadowDeployVerdict: inputs.shadowDeploy?.verdict ?? "none",
    semanticConflicts: inputs.semanticGit?.conflicts?.length ?? 0,
    probabilisticExperiments: inputs.probabilistic?.experiments?.length ?? 0,
    specContracts: inputs.specCode?.contracts?.length ?? 0,
    conversationSymbols: inputs.conversations?.symbols?.length ?? 0,
    fluidCapabilities: inputs.fluidMesh?.capabilities?.length ?? 0,
    naturalLanguageOperations: inputs.naturalLanguage?.ir?.operations ?? [],
    proofVerdict: inputs.proofCarryingChange?.verdict ?? "none",
    causalSuspects: inputs.causalAutopsy?.suspects?.length ?? 0
  };
}

function nextInterventions(inputs: Record<string, any>): string[] {
  const actions: string[] = [];
  if (!inputs.selfDefense) actions.push("Run workspace.self_defend to establish an immune baseline.");
  if (!inputs.precrime) actions.push("Run workspace.precrime to identify likely future failures.");
  if (!inputs.specCode) actions.push("Run workspace.spec_code to synthesize behavior contracts.");
  if (!inputs.conversations) actions.push("Run workspace.conversational_codebase action=map to create symbol memory.");
  if (!inputs.fluidMesh) actions.push("Run workspace.fluid_mesh to map reusable capabilities.");
  if (!inputs.naturalLanguage) actions.push("Run workspace.natural_language_source to compile an intent into an implementation IR.");
  if (!inputs.proofCarryingChange) actions.push("Run workspace.proof_carrying_change before promoting the next change.");
  if (!inputs.causalAutopsy) actions.push("Run workspace.causal_autopsy after the next failure to persist causal memory.");
  if (actions.length === 0) actions.push("Refresh all ledgers after the next meaningful code change.");
  return actions;
}
