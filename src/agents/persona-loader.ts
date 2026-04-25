import { promises as fs } from "node:fs";
import path from "node:path";

export interface PersonaDefinition {
  name: string;
  systemPrompt: string;
  toolWhitelist: string[];
  verificationRules: string[];
  escalationThreshold: "low" | "medium" | "high";
}

export class PersonaLoader {
  constructor(private readonly workspaceRoot: string) {}

  async list(): Promise<PersonaDefinition[]> {
    const personaDir = path.join(this.workspaceRoot, ".mesh", "personas");
    try {
      const files = await fs.readdir(personaDir);
      const rows = await Promise.all(files
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => this.readPersona(path.join(personaDir, entry))));
      return rows.filter((row): row is PersonaDefinition => Boolean(row));
    } catch {
      return [];
    }
  }

  async assembleTeam(task: string): Promise<{
    ok: boolean;
    task: string;
    labels: string[];
    personas: PersonaDefinition[];
  }> {
    const personas = await this.list();
    const labels = classifyTask(task);
    const selected = personas.filter((persona) => labels.includes(persona.name));
    return {
      ok: true,
      task,
      labels,
      personas: selected.length > 0 ? selected : personas.slice(0, 2)
    };
  }

  private async readPersona(filePath: string): Promise<PersonaDefinition | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const basename = path.basename(filePath, ".md");
      const prompt = raw.trim();
      return {
        name: basename,
        systemPrompt: prompt,
        toolWhitelist: parseList(raw, "tool_whitelist"),
        verificationRules: parseList(raw, "verification_rules"),
        escalationThreshold: (parseScalar(raw, "escalation_threshold") as "low" | "medium" | "high") || "medium"
      };
    } catch {
      return null;
    }
  }
}

function classifyTask(task: string): string[] {
  const labels = new Set<string>();
  if (/security|xss|auth|token|cve/i.test(task)) labels.add("security");
  if (/perf|latency|p99|slow|optimi[sz]e/i.test(task)) labels.add("performance");
  if (/a11y|accessibility|aria|screen reader/i.test(task)) labels.add("a11y");
  if (/db|query|migration|sql|prisma/i.test(task)) labels.add("db");
  if (/infra|deploy|ci|docker|kubernetes|helm/i.test(task)) labels.add("devops");
  if (/frontend|ui|react|css|component/i.test(task)) labels.add("frontend");
  if (/test|coverage|spec|jest|vitest|playwright/i.test(task)) labels.add("testing");
  return Array.from(labels);
}

function parseList(raw: string, key: string): string[] {
  const match = raw.match(new RegExp(`${key}\\s*:\\s*\\[(.*?)\\]`, "is"));
  if (!match) return [];
  return match[1]
    .split(",")
    .map((item) => item.replace(/['"`]/g, "").trim())
    .filter(Boolean);
}

function parseScalar(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`${key}\\s*:\\s*([\\w-]+)`, "i"));
  return match ? match[1].trim() : null;
}
