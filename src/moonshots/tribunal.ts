import { promises as fs } from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./common.js";

export type TribunalLlmCall = (
  systemPrompt: string,
  userPrompt: string,
  temperature?: number,
  modelHint?: string
) => Promise<string>;

interface Panelist {
  id: string;
  persona: string;
  focus: string;
  modelHint?: string;
  temperature: number;
}

interface Proposal {
  panelistId: string;
  persona: string;
  solution: string;
  reasoning: string;
  tradeoffs: string;
}

interface Critique {
  critiquedBy: string;
  targetPanelistId: string;
  verdict: "adopt" | "partial" | "reject";
  strengths: string;
  weaknesses: string;
  suggestedMerge: string;
}

interface TribunalSynthesis {
  dominantSolution: string;
  winningPanelistId: string;
  incorporated: string[];
  rationale: string;
  verdict: "consensus" | "majority" | "disputed";
  scores: Record<string, number>;
  dissent: string;
}

export interface TribunalResult {
  ok: boolean;
  action: string;
  problem: string;
  generatedAt: string;
  panelists: Panelist[];
  proposals: Proposal[];
  critiques: Critique[];
  synthesis: TribunalSynthesis;
  decisionArtifactPath: string;
}

const PANELISTS: Panelist[] = [
  {
    id: "correctness",
    persona: "Correctness & DX Engineer",
    focus: "semantic correctness, type safety, developer ergonomics, clean abstractions, and maintainability",
    temperature: 0
  },
  {
    id: "performance",
    persona: "Performance & Efficiency Engineer",
    focus: "runtime performance, memory efficiency, algorithmic complexity, bundle size, and resource usage",
    modelHint: "haiku",
    temperature: 0.1
  },
  {
    id: "resilience",
    persona: "Security & Resilience Engineer",
    focus: "edge case coverage, error handling, security boundaries, invariant preservation, and production failure modes",
    temperature: 0.3
  }
];

export class TribunalEngine {
  constructor(
    private readonly workspaceRoot: string,
    private readonly callLlm?: TribunalLlmCall
  ) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "convene").trim().toLowerCase();
    if (action === "status") return this.status();
    if (action !== "convene") throw new Error("workspace.tribunal action must be convene|status");

    const problem = String(args.problem ?? "").trim();
    if (!problem) throw new Error("workspace.tribunal convene requires a non-empty problem");

    if (!this.callLlm) {
      return { ok: false, reason: "Tribunal requires LLM access. Configuration not available." };
    }

    const context = String(args.context ?? "").trim();
    return this.convene(problem, context) as unknown as Promise<Record<string, unknown>>;
  }

  private async convene(problem: string, context: string): Promise<TribunalResult> {
    const contextSection = context ? `\n\nAdditional context:\n${context}` : "";

    // Phase 1: Independent proposals (parallel)
    const proposals = await Promise.all(
      PANELISTS.map(panelist => this.solicit(panelist, problem, contextSection))
    );

    // Phase 2: Cross-critiques — each panelist critiques both others (parallel)
    const critiqueJobs = PANELISTS.flatMap(critic =>
      proposals
        .filter(p => p.panelistId !== critic.id)
        .map(target => ({ critic, target }))
    );
    const critiques = await Promise.all(
      critiqueJobs.map(({ critic, target }) => this.critique(critic, target, problem))
    );

    // Phase 3: Score and synthesize
    const synthesis = await this.synthesize(problem, proposals, critiques);

    const result: TribunalResult = {
      ok: true,
      action: "convene",
      problem,
      generatedAt: new Date().toISOString(),
      panelists: PANELISTS,
      proposals,
      critiques,
      synthesis,
      decisionArtifactPath: ".mesh/tribunal/latest.json"
    };

    const dir = path.join(this.workspaceRoot, ".mesh", "tribunal");
    await fs.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, "latest.json"), result);
    await fs.appendFile(
      path.join(dir, "history.jsonl"),
      JSON.stringify({
        problem: problem.slice(0, 120),
        generatedAt: result.generatedAt,
        verdict: synthesis.verdict,
        winner: synthesis.winningPanelistId
      }) + "\n",
      "utf8"
    );

    return result;
  }

  private async solicit(panelist: Panelist, problem: string, contextSection: string): Promise<Proposal> {
    const system = `You are a ${panelist.persona}. Your primary lens is: ${panelist.focus}. Be concise, specific, and opinionated.`;
    const user = [
      `Engineering problem:${contextSection}`,
      ``,
      problem,
      ``,
      `Provide your expert solution. Respond with JSON only:`,
      `{"solution":"<implementation approach, 3-6 sentences>","reasoning":"<why this is correct from your lens, 2-3 sentences>","tradeoffs":"<what this approach sacrifices, 1-2 sentences>"}`
    ].join("\n");

    try {
      const raw = await this.callLlm!(system, user, panelist.temperature, panelist.modelHint);
      const parsed = extractJson(raw);
      return {
        panelistId: panelist.id,
        persona: panelist.persona,
        solution: String(parsed?.solution ?? raw.slice(0, 500)),
        reasoning: String(parsed?.reasoning ?? ""),
        tradeoffs: String(parsed?.tradeoffs ?? "")
      };
    } catch {
      return {
        panelistId: panelist.id,
        persona: panelist.persona,
        solution: `[${panelist.persona} failed to respond]`,
        reasoning: "",
        tradeoffs: ""
      };
    }
  }

  private async critique(critic: Panelist, target: Proposal, problem: string): Promise<Critique> {
    const system = `You are a ${critic.persona}. Your primary lens is: ${critic.focus}. Evaluate another engineer's solution critically but fairly.`;
    const user = [
      `Original problem: ${problem.slice(0, 300)}`,
      ``,
      `${target.persona}'s solution:`,
      target.solution,
      ``,
      `Evaluate this from your ${critic.focus} perspective. Respond with JSON only:`,
      `{"verdict":"adopt|partial|reject","strengths":"<what this gets right, 1-2 sentences>","weaknesses":"<what this misses from your lens, 1-2 sentences>","suggestedMerge":"<what element to borrow if partial or reject, or empty string>"}`
    ].join("\n");

    try {
      const raw = await this.callLlm!(system, user, 0.1);
      const parsed = extractJson(raw);
      const rawVerdict = String(parsed?.verdict ?? "partial").toLowerCase();
      const verdict = (["adopt", "partial", "reject"].includes(rawVerdict) ? rawVerdict : "partial") as "adopt" | "partial" | "reject";
      return {
        critiquedBy: critic.id,
        targetPanelistId: target.panelistId,
        verdict,
        strengths: String(parsed?.strengths ?? ""),
        weaknesses: String(parsed?.weaknesses ?? ""),
        suggestedMerge: String(parsed?.suggestedMerge ?? "")
      };
    } catch {
      return {
        critiquedBy: critic.id,
        targetPanelistId: target.panelistId,
        verdict: "partial",
        strengths: "",
        weaknesses: "[Critique failed]",
        suggestedMerge: ""
      };
    }
  }

  private async synthesize(problem: string, proposals: Proposal[], critiques: Critique[]): Promise<TribunalSynthesis> {
    // Score each panelist: adopt=2, partial=1, reject=0
    const scores: Record<string, number> = Object.fromEntries(PANELISTS.map(p => [p.id, 0]));
    for (const critique of critiques) {
      const delta = critique.verdict === "adopt" ? 2 : critique.verdict === "partial" ? 1 : 0;
      scores[critique.targetPanelistId] = (scores[critique.targetPanelistId] ?? 0) + delta;
    }

    const maxScore = (PANELISTS.length - 1) * 2;
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [winnerId, winnerScore] = ranked[0];
    const [, secondScore] = ranked[1] ?? ["", 0];
    const winnerProposal = proposals.find(p => p.panelistId === winnerId)!;

    const verdict: TribunalSynthesis["verdict"] =
      winnerScore >= maxScore ? "consensus" :
      winnerScore > secondScore ? "majority" : "disputed";

    // Gather merges suggested for the winner
    const incorporated = critiques
      .filter(c => c.targetPanelistId === winnerId && c.suggestedMerge)
      .map(c => c.suggestedMerge)
      .filter(Boolean);

    // Synthesis call
    const synthesisUser = [
      `Problem: ${problem.slice(0, 400)}`,
      ``,
      `Winning solution (${winnerProposal.persona}, score ${winnerScore}/${maxScore}):`,
      winnerProposal.solution,
      ``,
      incorporated.length > 0
        ? `Elements to incorporate from other proposals:\n${incorporated.map(i => `- ${i}`).join("\n")}`
        : `No additional elements needed.`,
      ``,
      `Write a final unified solution (3-5 sentences) and a rationale (2 sentences) for why it won. JSON only:`,
      `{"dominantSolution":"<final unified solution>","rationale":"<why this won the tribunal>"}`
    ].join("\n");

    let dominantSolution = winnerProposal.solution;
    let rationale = `${winnerProposal.persona}'s solution scored ${winnerScore}/${maxScore} in the tribunal.`;

    try {
      const raw = await this.callLlm!(
        "You are a synthesis arbiter. Produce a concise, actionable final engineering decision.",
        synthesisUser,
        0
      );
      const parsed = extractJson(raw);
      if (parsed?.dominantSolution) dominantSolution = String(parsed.dominantSolution);
      if (parsed?.rationale) rationale = String(parsed.rationale);
    } catch {
      // Keep defaults — tribunal still succeeds
    }

    const loserEntry = ranked[ranked.length - 1];
    const loserProposal = proposals.find(p => p.panelistId === loserEntry[0]);
    const dissent = verdict === "disputed" && loserProposal
      ? `${loserProposal.persona} dissents: ${loserProposal.reasoning.slice(0, 180)}`
      : "";

    return { dominantSolution, winningPanelistId: winnerId, incorporated, rationale, verdict, scores, dissent };
  }

  private async status(): Promise<Record<string, unknown>> {
    return readJson(path.join(this.workspaceRoot, ".mesh", "tribunal", "latest.json"), {
      ok: true,
      action: "status",
      message: "No tribunal has been convened yet. Use action=convene with a problem."
    });
  }
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const target = fenced ? fenced[1] : raw;
  const braced = target.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(braced ? braced[0] : target) as Record<string, unknown>;
  } catch {
    return null;
  }
}
