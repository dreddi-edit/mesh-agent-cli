import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendJsonl, collectWorkspaceFiles, readJson, toPosix, writeJson } from "./moonshots/common.js";

const execFileAsync = promisify(execFile);

type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;
type BrainAction = "build" | "query" | "status" | "record" | "ingest" | "export";

interface CompanyBrainDocument {
  i: string; // id
  k: "source" | "test" | "config" | "doc" | "memory" | "runtime" | "issue" | "symbol" | "route"; // kind
  f?: string; // file
  t: string; // title
  s?: number; // lineStart
  e?: number; // lineEnd
  x: string; // text
  w: string[]; // keywords
  d?: string; // domain
  z?: number; // score (was score)
}

interface CompanyBrainEvent {
  id: string;
  at: string;
  kind: string;
  title: string;
  body: string;
  files: string[];
  source: string;
}

interface CompanyBrainState {
  schemaVersion: 2;
  builtAt: string;
  workspace: {
    rootHash: string;
    name: string;
    packageName?: string;
    packageVersion?: string;
  };
  summary: {
    files: number;
    documents: number;
    domains: Array<{ name: string; files: number; risks: number }>;
    topRisks: Array<{ file: string; risks: string[]; score: number }>;
    commands: string[];
  };
  memory: {
    rules: string[];
    decisions: string[];
    acceptedPatterns: string[];
    rejectedPatterns: string[];
    events: CompanyBrainEvent[];
  };
  documents: CompanyBrainDocument[];
  git: {
    branch?: string;
    recentCommits: string[];
    activeFiles: string[];
  };
  sourceArtifacts: {
    digitalTwinPath?: string;
    engineeringMemoryPath?: string;
    brainPath: string;
    summaryPath: string;
  };
}

export class CompanyBrainEngine {
  constructor(
    private readonly workspaceRoot: string,
    private readonly callTool?: ToolCaller
  ) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = normalizeAction(String(args.action ?? "status"));
    if (action === "build") return this.build(args);
    if (action === "query") return this.query(args);
    if (action === "record") return this.record(args);
    if (action === "ingest") return this.ingest(args);
    if (action === "export") return this.export(args);
    return this.status();
  }

  async build(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const maxFiles = clampNumber(args.maxFiles, 1200, 50, 5000);
    const [packageJson, git, digitalTwin, engineeringMemory, issues] = await Promise.all([
      readJson<any | null>(path.join(this.workspaceRoot, "package.json"), null),
      this.gitContext(),
      this.safeTool<any>("workspace.digital_twin", { action: "build" }),
      this.safeTool<any>("workspace.engineering_memory", { action: "read" }),
      readJson<any[]>(path.join(this.workspaceRoot, ".mesh", "issues-snapshot.json"), [])
    ]);

    const files = await collectWorkspaceFiles(this.workspaceRoot, {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".yml", ".yaml", ".toml", ".sql", ".graphql"],
      maxFiles
    });
    const documents: CompanyBrainDocument[] = [];
    for (const file of files) {
      const absolute = ensureInsideRoot(this.workspaceRoot, file);
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat?.isFile() || stat.size > 1_500_000) continue;
      const raw = await fs.readFile(absolute, "utf8").catch(() => "");
      if (!raw.trim()) continue;
      documents.push(...extractFileDocuments(file, raw));
    }

    const twin = digitalTwin?.twin ?? digitalTwin ?? {};
    const memory = engineeringMemory?.memory ?? {};
    documents.push(...memoryDocuments(memory));
    documents.push(...digitalTwinDocuments(twin));
    documents.push(...issueDocuments(issues));

    const riskHotspots = Array.isArray(twin?.riskHotspots) ? twin.riskHotspots : [];
    const domains = summarizeDomains(files, riskHotspots);
    const state: CompanyBrainState = {
      schemaVersion: 2,
      builtAt: new Date().toISOString(),
      workspace: {
        rootHash: rootHash(this.workspaceRoot),
        name: path.basename(this.workspaceRoot),
        packageName: packageJson?.name,
        packageVersion: packageJson?.version
      },
      summary: {
        files: files.length,
        documents: documents.length,
        domains,
        topRisks: riskHotspots.slice(0, 20).map((entry: any) => ({
          file: String(entry.file ?? ""),
          risks: Array.isArray(entry.risks) ? entry.risks.map(String).slice(0, 8) : [],
          score: Number(entry.score ?? 0)
        })),
        commands: Object.entries(packageJson?.scripts ?? {})
          .filter(([name]) => /test|typecheck|lint|build|start|dev|deploy/i.test(name))
          .map(([name, command]) => `${name}: ${command}`)
          .slice(0, 24)
      },
      memory: {
        rules: stringArray(memory.rules, 200),
        decisions: stringArray(memory.decisions, 200),
        acceptedPatterns: stringArray(memory.acceptedPatterns, 200),
        rejectedPatterns: stringArray(memory.rejectedPatterns, 200),
        events: Array.isArray(memory.events)
          ? memory.events.slice(0, 100).map((event: any) => ({
              id: String(event.id ?? `mem-${crypto.randomUUID()}`),
              at: String(event.at ?? event.createdAt ?? new Date().toISOString()),
              kind: String(event.outcome ?? event.kind ?? "memory"),
              title: String(event.rule ?? event.note ?? "Memory event").slice(0, 160),
              body: String(event.note ?? event.rule ?? ""),
              files: Array.isArray(event.files) ? event.files.map(String).slice(0, 20) : [],
              source: String(event.source ?? "engineering_memory")
            }))
          : []
      },
      documents: documents.slice(0, 6000),
      git,
      sourceArtifacts: {
        digitalTwinPath: digitalTwin?.path ? String(digitalTwin.path) : undefined,
        engineeringMemoryPath: engineeringMemory?.path ? String(engineeringMemory.path) : undefined,
        brainPath: relativeArtifact(this.brainPath()),
        summaryPath: relativeArtifact(this.summaryPath())
      }
    };

    await writeJson(this.brainPath(), state);
    await fs.mkdir(path.dirname(this.summaryPath()), { recursive: true });
    await fs.writeFile(this.summaryPath(), renderBrainSummary(state), "utf8");
    return {
      ok: true,
      action: "build",
      path: relativeArtifact(this.brainPath()),
      summaryPath: relativeArtifact(this.summaryPath()),
      stats: state.summary,
      memory: {
        rules: state.memory.rules.length,
        decisions: state.memory.decisions.length,
        events: state.memory.events.length
      }
    };
  }

  async query(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const question = String(args.query ?? args.question ?? "").trim();
    if (!question) throw new Error("workspace.company_brain query requires query");
    const limit = clampNumber(args.limit, 8, 1, 25);
    const state = await this.readOrBuild();
    const matches = scoreDocuments(question, state.documents).slice(0, limit);
    const rules = state.memory.rules.filter((rule) => lexicalScore(question, rule) > 0).slice(0, 8);
    return {
      ok: true,
      action: "query",
      query: question,
      builtAt: state.builtAt,
      answer: buildGroundedAnswer(question, matches, rules),
      citations: matches.map((doc) => ({
        id: doc.i,
        kind: doc.k,
        file: doc.f,
        lineStart: doc.s,
        lineEnd: doc.e,
        title: doc.t,
        score: Number((doc.z ?? 0).toFixed(3)),
        snippet: doc.x.slice(0, 600)
      })),
      memoryRules: rules,
      recommendedFiles: unique(matches.map((doc) => doc.f).filter((file): file is string => Boolean(file)), 12),
      path: relativeArtifact(this.brainPath())
    };
  }

  async record(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const kind = String(args.kind ?? "decision").trim().toLowerCase();
    const title = String(args.title ?? args.rule ?? args.note ?? "").trim();
    const body = String(args.body ?? args.note ?? args.rule ?? "").trim();
    if (!title && !body) throw new Error("workspace.company_brain record requires title/body/rule/note");
    const state = await this.readOrBuild();
    const event: CompanyBrainEvent = {
      id: `cb-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      at: new Date().toISOString(),
      kind,
      title: title || body.slice(0, 120),
      body,
      files: Array.isArray(args.files) ? unique(args.files.map(String), 40) : [],
      source: String(args.source ?? "manual")
    };
    state.memory.events.unshift(event);
    if (kind === "rule" && body) state.memory.rules = unique([body, ...state.memory.rules], 200);
    if (kind === "decision" && (title || body)) {
      state.memory.decisions = unique([`${event.title}${event.body && event.body !== event.title ? `: ${event.body}` : ""}`, ...state.memory.decisions], 200);
    }
    state.documents.unshift(eventDocument(event));
    state.builtAt = new Date().toISOString();
    await writeJson(this.brainPath(), state);
    await appendJsonl(this.eventsPath(), event);
    await fs.writeFile(this.summaryPath(), renderBrainSummary(state), "utf8");
    if (kind === "rule" && this.callTool) {
      await this.safeTool("workspace.engineering_memory", {
        action: "record",
        outcome: "neutral",
        rule: body || title,
        note: event.title,
        files: event.files
      });
    }
    return { ok: true, action: "record", event, path: relativeArtifact(this.brainPath()) };
  }

  async ingest(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const source = String(args.source ?? "runtime").trim().toLowerCase();
    const title = String(args.title ?? args.summary ?? source).trim();
    const body = String(args.body ?? args.details ?? args.summary ?? "").trim();
    return this.record({
      kind: source,
      title,
      body,
      files: Array.isArray(args.files) ? args.files : [],
      source
    });
  }

  async status(): Promise<Record<string, unknown>> {
    const state = await readJson<CompanyBrainState | null>(this.brainPath(), null);
    if (!state) {
      return {
        ok: true,
        action: "status",
        status: "missing",
        path: relativeArtifact(this.brainPath()),
        message: "Company Brain has not been built yet. Run workspace.company_brain action=build."
      };
    }
    return {
      ok: true,
      action: "status",
      status: "ready",
      builtAt: state.builtAt,
      path: relativeArtifact(this.brainPath()),
      summaryPath: relativeArtifact(this.summaryPath()),
      files: state.summary.files,
      documents: state.summary.documents,
      domains: state.summary.domains.slice(0, 10),
      rules: state.memory.rules.length,
      decisions: state.memory.decisions.length,
      events: state.memory.events.length
    };
  }

  async export(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const state = await this.readOrBuild();
    const requestedPath = String(args.path ?? ".mesh/company-brain/export.md").trim();
    const target = ensureInsideRoot(this.workspaceRoot, requestedPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, renderBrainSummary(state, true), "utf8");
    return { ok: true, action: "export", path: toPosix(path.relative(this.workspaceRoot, target)) };
  }

  private async readOrBuild(): Promise<CompanyBrainState> {
    const existing = await readJson<CompanyBrainState | null>(this.brainPath(), null);
    if (existing?.schemaVersion === 2) return existing;
    await this.build();
    const built = await readJson<CompanyBrainState | null>(this.brainPath(), null);
    if (!built) throw new Error("Company Brain build failed");
    return built;
  }

  private async safeTool<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
    if (!this.callTool) return null;
    try {
      return await this.callTool(name, args) as T;
    } catch {
      return null;
    }
  }

  private async gitContext(): Promise<CompanyBrainState["git"]> {
    const branch = await gitOutput(this.workspaceRoot, ["branch", "--show-current"]);
    const recent = await gitOutput(this.workspaceRoot, ["log", "--max-count=25", "--pretty=format:%h %ad %s", "--date=short"]);
    const active = await gitOutput(this.workspaceRoot, ["log", "--max-count=80", "--name-only", "--pretty=format:"]);
    const counts = new Map<string, number>();
    for (const line of active.split(/\r?\n/g)) {
      const file = line.trim();
      if (!file || /(^|\/)(node_modules|dist|\.git|\.mesh)(\/|$)/.test(file)) continue;
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    return {
      branch: branch.trim() || undefined,
      recentCommits: recent.split(/\r?\n/g).filter(Boolean).slice(0, 25),
      activeFiles: Array.from(counts.entries())
        .sort((left, right) => right[1] - left[1])
        .map(([file]) => file)
        .slice(0, 30)
    };
  }

  private brainPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "company-brain", "brain.json");
  }

  private summaryPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "company-brain", "summary.md");
  }

  private eventsPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "company-brain", "events.jsonl");
  }
}

function normalizeAction(value: string): BrainAction {
  const normalized = value.trim().toLowerCase().replace("-", "_");
  if (normalized === "ask" || normalized === "search") return "query";
  if (["build", "query", "status", "record", "ingest", "export"].includes(normalized)) return normalized as BrainAction;
  return "status";
}

function extractFileDocuments(file: string, raw: string): CompanyBrainDocument[] {
  const safe = redactSecrets(raw).slice(0, 80_000);
  const lines = safe.split(/\r?\n/g);
  const kind = classifyFile(file);
  const domain = file.split("/")[0] || ".";
  const docs: CompanyBrainDocument[] = [];
  const symbols = symbolHints(safe);
  if (symbols.length > 0) {
    docs.push({
      i: docId(file, "symbols", 1),
      k: "symbol",
      f: file,
      t: `Symbols in ${file}`,
      s: 1,
      e: Math.min(lines.length, 200),
      x: symbols.slice(0, 80).join("\n"),
      w: keywords(`${file} ${symbols.join(" ")}`),
      d: domain
    });
  }
  const routes = routeHints(safe);
  if (routes.length > 0) {
    docs.push({
      i: docId(file, "routes", 1),
      k: "route",
      f: file,
      t: `Routes in ${file}`,
      s: 1,
      e: Math.min(lines.length, 200),
      x: routes.slice(0, 80).join("\n"),
      w: keywords(`${file} ${routes.join(" ")}`),
      d: domain
    });
  }
  const chunkSize = kind === "doc" ? 90 : 70;
  for (let start = 0; start < lines.length; start += chunkSize) {
    const slice = lines.slice(start, start + chunkSize);
    const text = slice.join("\n").trim();
    if (!text) continue;
    docs.push({
      i: docId(file, kind, start + 1),
      k: kind,
      f: file,
      t: `${file}:${start + 1}`,
      s: start + 1,
      e: Math.min(lines.length, start + slice.length),
      x: text.slice(0, 2400),
      w: keywords(`${file}\n${text}`),
      d: domain
    });
  }
  return docs;
}

function memoryDocuments(memory: Record<string, any>): CompanyBrainDocument[] {
  const docs: CompanyBrainDocument[] = [];
  for (const [key, values] of Object.entries({
    rules: memory.rules,
    decisions: memory.decisions,
    acceptedPatterns: memory.acceptedPatterns,
    rejectedPatterns: memory.rejectedPatterns
  })) {
    const text = stringArray(values, 200).join("\n");
    if (!text.trim()) continue;
    docs.push({
      i: docId(`memory:${key}`, "memory", 1),
      k: "memory",
      t: `Engineering memory: ${key}`,
      x: text,
      w: keywords(text)
    });
  }
  return docs;
}

function digitalTwinDocuments(twin: Record<string, any>): CompanyBrainDocument[] {
  const docs: CompanyBrainDocument[] = [];
  const routes = Array.isArray(twin?.routes) ? twin.routes : [];
  if (routes.length > 0) {
    const text = routes.slice(0, 250).map((entry: any) => `${entry.file ?? ""} ${entry.method ?? ""} ${entry.path ?? entry.route ?? ""}`).join("\n");
    docs.push({ i: "digital-twin-routes", k: "route", t: "Digital Twin Routes", x: text, w: keywords(text) });
  }
  const risks = Array.isArray(twin?.riskHotspots) ? twin.riskHotspots : [];
  if (risks.length > 0) {
    const text = risks.slice(0, 200).map((entry: any) => `${entry.file}: ${(entry.risks ?? []).join(", ")}`).join("\n");
    docs.push({ i: "digital-twin-risks", k: "runtime", t: "Digital Twin Risk Hotspots", x: text, w: keywords(text) });
  }
  return docs;
}

function issueDocuments(issues: any[]): CompanyBrainDocument[] {
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 200).map((issue, index) => {
    const text = `${issue.provider ?? "issue"} ${issue.id ?? index}: ${issue.title ?? ""}\n${issue.body ?? ""}`;
    return {
      i: `issue-${issue.provider ?? "local"}-${issue.id ?? index}`,
      k: "issue" as const,
      t: String(issue.title ?? `Issue ${index + 1}`),
      x: redactSecrets(text).slice(0, 2000),
      w: keywords(text)
    };
  });
}

function eventDocument(event: CompanyBrainEvent): CompanyBrainDocument {
  const text = `${event.kind}: ${event.title}\n${event.body}\n${event.files.join("\n")}`;
  return {
    i: event.id,
    k: "memory",
    t: event.title,
    x: text,
    w: keywords(text)
  };
}

function classifyFile(file: string): CompanyBrainDocument["k"] {
  if (/(\.test|\.spec)\.(ts|tsx|js|jsx|mjs|cjs)$|(^|\/)(test|tests|__tests__)\//.test(file)) return "test";
  if (/\.(md|mdx)$/.test(file)) return "doc";
  if (/(^|\/)(package\.json|tsconfig\.json|.*config.*|Dockerfile|\.github\/workflows|.*\.ya?ml|.*\.toml)$/.test(file)) return "config";
  return "source";
}

function symbolHints(raw: string): string[] {
  const matches = Array.from(raw.matchAll(/\b(export\s+)?(class|function|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g));
  return unique(matches.map((match) => `${match[2]} ${match[3]}`), 120);
}

function routeHints(raw: string): string[] {
  const results: string[] = [];
  for (const match of raw.matchAll(/\b(app|router)\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/g)) {
    results.push(`${match[2].toUpperCase()} ${match[3]}`);
  }
  for (const match of raw.matchAll(/\b(method|path|route)\s*:\s*["'`]([^"'`]+)["'`]/g)) {
    results.push(`${match[1]}=${match[2]}`);
  }
  return unique(results, 120);
}

function summarizeDomains(files: string[], risks: any[]): Array<{ name: string; files: number; risks: number }> {
  const riskCounts = new Map<string, number>();
  for (const entry of risks) {
    const file = String(entry.file ?? "");
    const domain = file.split("/")[0] || ".";
    riskCounts.set(domain, (riskCounts.get(domain) ?? 0) + 1);
  }
  const counts = new Map<string, number>();
  for (const file of files) {
    const domain = file.split("/")[0] || ".";
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, files: count, risks: riskCounts.get(name) ?? 0 }))
    .sort((left, right) => right.files + right.risks * 4 - (left.files + left.risks * 4))
    .slice(0, 30);
}

function scoreDocuments(query: string, docs: CompanyBrainDocument[]): CompanyBrainDocument[] {
  return docs
    .map((doc) => ({ ...doc, z: lexicalScore(query, `${doc.t}\n${doc.f ?? ""}\n${doc.x}\n${doc.w.join(" ")}`) }))
    .filter((doc) => (doc.z ?? 0) > 0)
    .sort((left, right) => (right.z ?? 0) - (left.z ?? 0));
}

function lexicalScore(query: string, text: string): number {
  const tokens = keywords(query);
  if (tokens.length === 0) return 0;
  const haystack = ` ${text.toLowerCase()} `;
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(` ${token} `)) score += 1.8;
    else if (haystack.includes(token)) score += 0.75;
  }
  const phrase = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (phrase.length > 5 && haystack.includes(phrase)) score += 4;
  return score / Math.sqrt(tokens.length);
}

function buildGroundedAnswer(query: string, matches: CompanyBrainDocument[], rules: string[]): string {
  if (matches.length === 0 && rules.length === 0) {
    return `No strong Company Brain matches for "${query}". Rebuild the brain after indexing or ask a narrower question.`;
  }
  const topFiles = unique(matches.map((doc) => doc.f).filter((file): file is string => Boolean(file)), 5);
  const topKinds = unique(matches.map((doc) => doc.k), 5);
  return [
    `Company Brain found ${matches.length} grounded match(es) for "${query}".`,
    topFiles.length > 0 ? `Most relevant files: ${topFiles.join(", ")}.` : "",
    topKinds.length > 0 ? `Evidence types: ${topKinds.join(", ")}.` : "",
    rules.length > 0 ? `Relevant rules: ${rules.slice(0, 3).join(" | ")}` : ""
  ].filter(Boolean).join(" ");
}

function renderBrainSummary(state: CompanyBrainState, extended = false): string {
  const lines = [
    "# Mesh Company Brain",
    "",
    `Built: ${state.builtAt}`,
    `Workspace: ${state.workspace.name}`,
    `Package: ${state.workspace.packageName ?? "unknown"} ${state.workspace.packageVersion ?? ""}`.trim(),
    "",
    "## Operating Context",
    `- Files indexed: ${state.summary.files}`,
    `- Evidence documents: ${state.summary.documents}`,
    `- Branch: ${state.git.branch ?? "unknown"}`,
    "",
    "## Core Domains",
    ...state.summary.domains.slice(0, 10).map((entry) => `- ${entry.name}: ${entry.files} files, ${entry.risks} risk signals`),
    "",
    "## Rules",
    ...(state.memory.rules.length > 0 ? state.memory.rules.slice(0, extended ? 40 : 12).map((rule) => `- ${rule}`) : ["- No rules recorded yet."]),
    "",
    "## Decisions",
    ...(state.memory.decisions.length > 0 ? state.memory.decisions.slice(0, extended ? 40 : 12).map((decision) => `- ${decision}`) : ["- No decisions recorded yet."]),
    "",
    "## Risk Hotspots",
    ...(state.summary.topRisks.length > 0
      ? state.summary.topRisks.slice(0, extended ? 40 : 12).map((risk) => `- ${risk.file}: ${risk.risks.join(", ")}`)
      : ["- No risk hotspots detected."]),
    "",
    "## Verification Commands",
    ...(state.summary.commands.length > 0 ? state.summary.commands.slice(0, 16).map((cmd) => `- ${cmd}`) : ["- No package scripts detected."])
  ];
  if (extended) {
    lines.push("", "## Recent Commits", ...state.git.recentCommits.slice(0, 25).map((commit) => `- ${commit}`));
  }
  return lines.join("\n") + "\n";
}

function keywords(value: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "into", "are", "was", "were", "und", "der", "die", "das", "ein", "eine", "ist", "mit", "von"]);
  return unique(
    value
      .toLowerCase()
      .split(/[^a-z0-9_.$/-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !stop.has(token)),
    80
  );
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(nvapi-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_NVIDIA_KEY]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*|[A-Za-z0-9_]*SECRET[A-Za-z0-9_]*|[A-Za-z0-9_]*KEY[A-Za-z0-9_]*)\s*=\s*.+/gi, "$1=[REDACTED]");
}

function stringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? unique(value.map(String).filter(Boolean), limit) : [];
}

function unique<T>(values: T[], limit = 100): T[] {
  return Array.from(new Set(values)).slice(0, limit);
}

function docId(file: string, kind: string, line: number): string {
  return crypto.createHash("sha1").update(`${file}:${kind}:${line}`).digest("hex").slice(0, 16);
}

function rootHash(root: string): string {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function ensureInsideRoot(root: string, requestedPath: string): string {
  const candidate = path.resolve(root, requestedPath);
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${requestedPath}`);
  }
  return candidate;
}

function relativeArtifact(absolutePath: string): string {
  const marker = `${path.sep}.mesh${path.sep}`;
  const index = absolutePath.indexOf(marker);
  return index >= 0 ? `.mesh/${toPosix(absolutePath.slice(index + marker.length))}` : absolutePath;
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  } catch (error: any) {
    return String(error.stdout ?? "");
  }
}
