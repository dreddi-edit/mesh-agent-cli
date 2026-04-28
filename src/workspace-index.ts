import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ignore, { Ignore } from "ignore";
import { MeshCoreAdapter, MeshCallSite, MeshSymbol } from "./mesh-core-adapter.js";
import { CacheManager } from "./cache-manager.js";
import { pipeline, env } from "@xenova/transformers";
import {
  DEFAULT_NVIDIA_EMBEDDING_MODELS,
  isNvidiaHostedModel,
  nvidiaEmbeddingWithFallbacks
} from "./nvidia-services.js";

// Optional: configure transformers env to avoid local caching issues
env.allowLocalModels = false;

const execFileAsync = promisify(execFile);

const INDEX_SCHEMA_VERSION = 1;
const INDEX_PARALLELISM = parseIntegerInRange(process.env.MESH_INDEX_PARALLELISM, 12, 1, 128);
const DEFAULT_EMBEDDING_MODEL = process.env.MESH_EMBEDDING_MODEL || DEFAULT_NVIDIA_EMBEDDING_MODELS[0];
const DEFAULT_SKIP_DIRS = [
  ".git",
  ".mesh",
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache"
];
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".br",
  ".wasm",
  ".dylib",
  ".so",
  ".dll"
]);
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "how",
  "where",
  "what",
  "why",
  "are",
  "does",
  "into",
  "über",
  "wie",
  "wo",
  "was",
  "warum",
  "ist",
  "der",
  "die",
  "das"
]);

export type CodeQueryMode =
  | "architecture"
  | "bug"
  | "edit-impact"
  | "test-impact"
  | "ownership"
  | "recent-change"
  | "runtime-path";

export interface WorkspaceIndexStatus {
  ok: true;
  workspaceRoot: string;
  workspaceHash: string;
  indexPath: string;
  schemaVersion: number;
  indexedAt: string | null;
  totalFiles: number;
  indexedFiles: number;
  cachedFiles: number;
  staleFiles: number;
  percent: number;
}

export interface CodeCitation {
  file: string;
  symbol?: string;
  lines?: { start: number; end: number };
  confidence: number;
  whyMatched: string[];
}

export interface CodeSearchResult {
  file: string;
  score: number;
  confidence: number;
  mode: CodeQueryMode;
  purpose: string;
  citations: CodeCitation[];
  matchedSignals: string[];
  dependencies: string[];
  tests: string[];
  recentChange?: GitFileHistory;
}

interface RouteRecord {
  method: string;
  route: string;
  line: number;
}

interface SymbolRecord extends MeshSymbol {
  signature?: string;
}

interface GitFileHistory {
  lastCommit?: string;
  lastCommitDate?: string;
  lastCommitSubject?: string;
  dirty?: boolean;
}

interface StructuredCapsule {
  purpose: string;
  exports: string[];
  imports: string[];
  symbols: Array<{ name: string; kind: string; lines: string }>;
  sideEffects: string[];
  risks: string[];
  testLinks: string[];
}

interface IndexedChunk {
  id: string;
  kind: "file" | "symbol" | "route" | "test";
  text: string;
  lineStart: number;
  lineEnd: number;
  vector: number[];
}

interface IndexedFileRecord {
  path: string;
  size: number;
  mtimeMs: number;
  language: string;
  lineCount: number;
  isTest: boolean;
  isDoc: boolean;
  imports: string[];
  exports: string[];
  dependencies: string[];
  dependents: string[];
  routes: RouteRecord[];
  symbols: SymbolRecord[];
  callSites: MeshCallSite[];
  git: GitFileHistory;
  capsule: StructuredCapsule;
  chunks: IndexedChunk[];
  textVector: number[];
}

interface PersistedWorkspaceIndex {
  schemaVersion: number;
  workspaceRoot: string;
  workspaceHash: string;
  indexedAt: string;
  files: IndexedFileRecord[];
}

interface BuildContext {
  dirtyFiles: Set<string>;
}

export class WorkspaceIndex {
  public readonly workspaceHash: string;
  public readonly indexBasePath: string;
  public readonly indexPath: string;

  private cachedIndex: PersistedWorkspaceIndex | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly meshCore: MeshCoreAdapter,
    private readonly cacheManager: CacheManager,
    private readonly config: { apiKey?: string; baseUrl?: string } = {}
  ) {
    this.workspaceHash = crypto
      .createHash("sha256")
      .update(path.resolve(workspaceRoot))
      .digest("hex")
      .slice(0, 24);
    this.indexBasePath = path.join(os.homedir(), ".config", "mesh", "indexes", this.workspaceHash);
    this.indexPath = path.join(this.indexBasePath, "index.json");
  }

  async status(): Promise<WorkspaceIndexStatus> {
    const files = await collectIndexableFiles(this.workspaceRoot, 10000, this.workspaceRoot);
    const index = await this.loadIndex();
    const indexed = new Map((index?.files ?? []).map((record) => [record.path, record]));
    let staleFiles = 0;

    for (const absolutePath of files) {
      const rel = toPosixRelative(this.workspaceRoot, absolutePath);
      const stat = await fs.stat(absolutePath).catch(() => null);
      const record = indexed.get(rel);
      if (!stat?.isFile() || !record) continue;
      if (Math.floor(stat.mtimeMs) !== record.mtimeMs || stat.size !== record.size) {
        staleFiles += 1;
      }
    }

    const indexedFiles = index?.files.length ?? 0;
    const freshFiles = Math.max(0, indexedFiles - staleFiles);
    return {
      ok: true,
      workspaceRoot: this.workspaceRoot,
      workspaceHash: this.workspaceHash,
      indexPath: this.indexPath,
      schemaVersion: INDEX_SCHEMA_VERSION,
      indexedAt: index?.indexedAt ?? null,
      totalFiles: files.length,
      indexedFiles,
      cachedFiles: freshFiles,
      staleFiles,
      percent: files.length > 0 ? Math.round((freshFiles / files.length) * 100) : 100
    };
  }

  async rebuild(onProgress?: (progress: { current: number; total: number; path: string }) => void): Promise<PersistedWorkspaceIndex> {
    const files = await collectIndexableFiles(this.workspaceRoot, 10000, this.workspaceRoot);
    const context: BuildContext = {
      dirtyFiles: await this.readDirtyFiles()
    };
    const indexedFiles: IndexedFileRecord[] = [];
    const total = files.length;
    const concurrency = INDEX_PARALLELISM;
    let completed = 0;

    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency);
      const records = await Promise.all(
        batch.map(async (absolutePath) => {
          const relativePath = toPosixRelative(this.workspaceRoot, absolutePath);
          try {
            return await this.buildRecord(absolutePath, relativePath, context);
          } catch {
            return null;
          } finally {
            completed += 1;
            onProgress?.({ current: completed, total, path: relativePath });
          }
        })
      );
      indexedFiles.push(...records.filter((record): record is IndexedFileRecord => Boolean(record)));
    }

    this.connectDependents(indexedFiles);
    this.connectTests(indexedFiles);

    const index: PersistedWorkspaceIndex = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      workspaceRoot: this.workspaceRoot,
      workspaceHash: this.workspaceHash,
      indexedAt: new Date().toISOString(),
      files: indexedFiles.sort((left, right) => left.path.localeCompare(right.path))
    };

    await fs.mkdir(this.indexBasePath, { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf8");
    this.cachedIndex = index;
    return index;
  }

  private async buildChunks(
    relativePath: string,
    raw: string,
    capsule: StructuredCapsule,
    symbols: SymbolRecord[],
    routes: RouteRecord[],
    isTest: boolean
  ): Promise<IndexedChunk[]> {
    const chunks: IndexedChunk[] = [
      {
        id: `${relativePath}:file`,
        kind: isTest ? "test" : "file",
        text: [
          capsule.purpose,
          capsule.exports.join(" "),
          capsule.imports.join(" "),
          capsule.sideEffects.join(" "),
          capsule.risks.join(" ")
        ].join("\n"),
        lineStart: 1,
        lineEnd: raw.split(/\r?\n/g).length,
        vector: await this.vectorize(capsule.purpose)
      }
    ];
    for (const symbol of symbols.slice(0, 80)) {
      const text = `${symbol.kind} ${symbol.name} ${symbol.signature ?? ""}`;
      chunks.push({
        id: `${relativePath}:${symbol.name}`,
        kind: "symbol",
        text,
        lineStart: symbol.lineStart,
        lineEnd: symbol.lineEnd,
        vector: await this.vectorize(text)
      });
    }
    for (const route of routes) {
      const text = `${route.method} ${route.route}`;
      chunks.push({
        id: `${relativePath}:route:${route.line}`,
        kind: "route",
        text,
        lineStart: route.line,
        lineEnd: route.line,
        vector: await this.vectorize(text)
      });
    }
    return chunks;
  }

  private async vectorize(value: string): Promise<number[]> {
    if (!value || value.trim() === "") return [];
    if (isRemoteEmbeddingModel(DEFAULT_EMBEDDING_MODEL)) {
      const result = await nvidiaEmbeddingWithFallbacks(
        value,
        {
          inputType: DEFAULT_EMBEDDING_MODEL.startsWith("nvidia/") ? "query" : undefined,
          models: [DEFAULT_EMBEDDING_MODEL, ...DEFAULT_NVIDIA_EMBEDDING_MODELS],
          apiKey: this.config.apiKey,
          baseUrl: this.config.baseUrl
        }
      );
      return result.embedding;
    }
    const extractor = await getEmbeddingPipeline();
    if (!extractor) return [];
    const output = await extractor(value, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }

  async getSemanticSlice(filePath: string, symbol: string): Promise<{ ok: boolean; error?: string; slice?: string }> {
    const target = symbol.trim().toLowerCase();
    if (!target) return { ok: false, error: "Symbol name required" };

    const index = await this.ensureIndex();
    const relPath = normalizeRelPath(toPosixRelative(this.workspaceRoot, path.resolve(this.workspaceRoot, filePath)));
    
    const record = index.files.find(f => f.path === relPath);
    if (!record) return { ok: false, error: "File not found in index" };

    const match = record.symbols.find(s => s.name.toLowerCase() === target || s.name.toLowerCase().includes(target));
    if (!match) return { ok: false, error: `Symbol '${symbol}' not found in ${relPath}` };

    try {
      const absPath = path.resolve(this.workspaceRoot, relPath);
      const raw = await fs.readFile(absPath, "utf8");
      const lines = raw.split(/\r?\n/g);
      
      const importLines: string[] = [];
      const importRegex = /^(?:import|export)\s+.*(?:from\s+["'][^"']+["']|require\(["'][^"']+["']\))/;
      for (const line of lines) {
        if (importRegex.test(line.trim())) {
          importLines.push(line);
        }
      }

      const bodyLines = lines.slice(match.lineStart - 1, match.lineEnd);
      
      const slice = [
        `// --- Context Sliced from ${relPath} ---`,
        `// Imports (${importLines.length} lines elided for brevity...)`,
        ...importLines.slice(0, 15),
        importLines.length > 15 ? "// ... more imports" : "",
        "",
        `// --- Symbol: ${match.kind} ${match.name} (L${match.lineStart}-L${match.lineEnd}) ---`,
        ...bodyLines
      ].filter(Boolean).join("\n");

      return { ok: true, slice };
    } catch (err) {
      return { ok: false, error: `Failed to read slice: ${(err as Error).message}` };
    }
  }

  async search(query: string, mode: CodeQueryMode = "architecture", limit = 8): Promise<{
    ok: true;
    query: string;
    mode: CodeQueryMode;
    indexStatus: WorkspaceIndexStatus;
    resultsFound: number;
    results: CodeSearchResult[];
    topMatches: Array<{ path: string; score: number; snippet: string }>;
  }> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error("workspace.ask_codebase requires a query");

    const index = await this.ensureIndex();
    const queryTokens = tokenize(normalizedQuery);
    const queryVector = await this.vectorize(normalizedQuery);
    const safeLimit = Math.max(1, Math.min(limit, 25));

    // Check RAG semantic cache
    const cachedResults = await this.cacheManager.getSimilarRagQuery(queryVector, 0.95);
    if (cachedResults) {
      const status = await this.status();
      return {
        ok: true,
        query: normalizedQuery,
        mode,
        indexStatus: status,
        resultsFound: cachedResults.length,
        results: cachedResults.slice(0, safeLimit),
        topMatches: cachedResults.slice(0, safeLimit).map((result) => ({
          path: result.file,
          score: result.score,
          snippet: `[Fonte: ${result.file}]\n${result.purpose}`
        }))
      };
    }

    const results: CodeSearchResult[] = [];

    for (const record of index.files) {
      const signals: string[] = [];
      const citations: CodeCitation[] = [];
      let score = 0;

      const keywordScore = scoreKeywordMatches(record, queryTokens, signals);
      score += keywordScore;

      const vectorScore = cosine(queryVector, record.textVector);
      if (vectorScore > 0.05) {
        score += vectorScore * 6;
        signals.push(`vector:${vectorScore.toFixed(2)}`);
      }

      const modeScore = scoreModeSignals(record, mode, normalizedQuery, queryTokens, signals);
      score += modeScore;

      const symbolCitation = bestSymbolCitation(record, queryTokens);
      if (symbolCitation) {
        score += 3;
        citations.push(symbolCitation);
      }

      const routeCitation = bestRouteCitation(record, queryTokens);
      if (routeCitation) {
        score += 2;
        citations.push(routeCitation);
      }

      if (record.git.dirty || mode === "recent-change") {
        score += record.git.dirty ? 2 : 0.25;
      }

      if (score <= 0) continue;

      if (citations.length === 0) {
        citations.push({
          file: record.path,
          lines: { start: 1, end: Math.min(record.lineCount, 40) },
          confidence: confidenceFromScore(score),
          whyMatched: signals.slice(0, 5)
        });
      }

      const confidence = confidenceFromScore(score);
      results.push({
        file: record.path,
        score: Number(score.toFixed(3)),
        confidence,
        mode,
        purpose: record.capsule.purpose,
        citations: citations.map((citation) => ({
          ...citation,
          confidence: Math.max(citation.confidence, confidence)
        })),
        matchedSignals: signals.slice(0, 10),
        dependencies: record.dependencies.slice(0, 10),
        tests: record.capsule.testLinks.slice(0, 10),
        recentChange: record.git.lastCommit || record.git.dirty ? record.git : undefined
      });
    }

    results.sort((left, right) => right.score - left.score);
    const sliced = results.slice(0, safeLimit);
    const status = await this.status();
    const response = {
      ok: true as const,
      query: normalizedQuery,
      mode,
      indexStatus: status,
      resultsFound: results.length,
      results: sliced,
      topMatches: sliced.map((result) => ({
        path: result.file,
        score: result.score,
        snippet: `[Fonte: ${result.file}]\n${result.purpose}`
      }))
    };

    // Cache the RAG query
    await this.cacheManager.setRagQuery(queryVector, sliced);

    return response;
  }

  async explainSymbol(symbol: string): Promise<{
    ok: true;
    symbol: string;
    matches: Array<{
      file: string;
      kind: string;
      lines: { start: number; end: number };
      signature?: string;
      imports: string[];
      exports: string[];
      callers: CodeCitation[];
      dependencies: string[];
      tests: string[];
    }>;
  }> {
    const target = symbol.trim();
    if (!target) throw new Error("workspace.explain_symbol requires symbol");

    const index = await this.ensureIndex();
    const matches = index.files.flatMap((record) =>
      record.symbols
        .filter((entry) => entry.name === target || entry.name.toLowerCase().includes(target.toLowerCase()))
        .map((entry) => {
          const callers = index.files
            .filter((candidate) => candidate.callSites.some((site) => site.callee === entry.name))
            .map((candidate) => {
              const site = candidate.callSites.find((callSite) => callSite.callee === entry.name);
              return {
                file: candidate.path,
                symbol: entry.name,
                lines: site ? { start: site.lineStart, end: site.lineEnd ?? site.lineStart } : undefined,
                confidence: 0.78,
                whyMatched: [`calls symbol ${entry.name}`]
              } satisfies CodeCitation;
            })
            .slice(0, 12);

          return {
            file: record.path,
            kind: entry.kind,
            lines: { start: entry.lineStart, end: entry.lineEnd },
            signature: entry.signature,
            imports: record.imports,
            exports: record.exports,
            callers,
            dependencies: record.dependencies,
            tests: record.capsule.testLinks
          };
        })
    );

    return { ok: true, symbol: target, matches };
  }

  async impactMap(args: { path?: string; symbol?: string; diff?: string }): Promise<{
    ok: true;
    target: string;
    impactedFiles: CodeCitation[];
    testImpact: CodeCitation[];
    dependencyImpact: CodeCitation[];
    runtimeImpact: CodeCitation[];
    residualRisk: string[];
  }> {
    const index = await this.ensureIndex();
    const targetPaths = new Set<string>();
    const symbol = args.symbol?.trim();

    if (args.path?.trim()) {
      targetPaths.add(normalizeRelPath(args.path));
    }
    if (args.diff?.trim()) {
      for (const filePath of extractPathsFromDiff(args.diff)) {
        targetPaths.add(normalizeRelPath(filePath));
      }
    }
    if (symbol) {
      for (const record of index.files) {
        if (record.symbols.some((entry) => entry.name === symbol)) {
          targetPaths.add(record.path);
        }
      }
    }
    if (targetPaths.size === 0) {
      throw new Error("workspace.impact_map requires path, symbol, or diff");
    }

    const impacted = new Map<string, CodeCitation>();
    const tests = new Map<string, CodeCitation>();
    const dependencies = new Map<string, CodeCitation>();
    const runtime = new Map<string, CodeCitation>();
    const risks = new Set<string>();

    for (const targetPath of targetPaths) {
      const sourceRecord = index.files.find((record) => record.path === targetPath);
      if (sourceRecord) {
        for (const dep of sourceRecord.dependencies) {
          const depRecord = index.files.find((record) => record.path === dep);
          if (depRecord) {
            dependencies.set(depRecord.path, citationForFile(depRecord, [`${targetPath} imports this dependency`], 0.66));
          }
        }
        for (const route of sourceRecord.routes) {
          runtime.set(sourceRecord.path, {
            file: sourceRecord.path,
            lines: { start: route.line, end: route.line },
            confidence: 0.75,
            whyMatched: [`runtime route ${route.method.toUpperCase()} ${route.route}`]
          });
        }
        for (const testPath of sourceRecord.capsule.testLinks) {
          const testRecord = index.files.find((record) => record.path === testPath);
          if (testRecord) {
            tests.set(testRecord.path, citationForFile(testRecord, [`test linked to ${targetPath}`], 0.72));
          }
        }
        for (const risk of sourceRecord.capsule.risks) risks.add(`${targetPath}: ${risk}`);
      }

      for (const record of index.files) {
        if (record.dependencies.includes(targetPath)) {
          impacted.set(record.path, citationForFile(record, [`depends on ${targetPath}`], 0.7));
        }
        if (symbol && record.callSites.some((site) => site.callee === symbol)) {
          impacted.set(record.path, citationForFile(record, [`calls ${symbol}`], 0.76));
        }
        if (record.isTest && fuzzyTestMatch(record.path, targetPath)) {
          tests.set(record.path, citationForFile(record, [`test filename matches ${targetPath}`], 0.62));
        }
      }
    }

    return {
      ok: true,
      target: symbol || Array.from(targetPaths).join(", "),
      impactedFiles: Array.from(impacted.values()).slice(0, 50),
      testImpact: Array.from(tests.values()).slice(0, 50),
      dependencyImpact: Array.from(dependencies.values()).slice(0, 50),
      runtimeImpact: Array.from(runtime.values()).slice(0, 50),
      residualRisk: Array.from(risks).slice(0, 20)
    };
  }

  async partialUpdate(relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    const index = await this.ensureIndex();
    const context: BuildContext = {
      dirtyFiles: await this.readDirtyFiles()
    };

    // 1. Identify dependents to re-index (semantic ripple effect)
    const expandedPaths = new Set(relativePaths);
    for (const relPath of relativePaths) {
      const record = index.files.find(f => f.path === relPath);
      if (record && record.dependents) {
        for (const dep of record.dependents) {
          expandedPaths.add(dep);
        }
      }
    }

    const pathsToProcess = Array.from(expandedPaths);
    const updatedFiles: IndexedFileRecord[] = [];
    
    // 2. Parallel processing with concurrency limit
    const concurrency = 8;
    for (let i = 0; i < pathsToProcess.length; i += concurrency) {
      const batch = pathsToProcess.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(async (relPath) => {
        const absPath = path.resolve(this.workspaceRoot, relPath);
        try {
          return await this.buildRecord(absPath, relPath, context);
        } catch {
          return null;
        }
      }));
      updatedFiles.push(...results.filter((f): f is IndexedFileRecord => f !== null));
    }

    if (updatedFiles.length > 0) {
      const fileMap = new Map(index.files.map(f => [f.path, f]));
      for (const record of updatedFiles) {
        fileMap.set(record.path, record);
      }
      
      const newFiles = Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));
      this.connectDependents(newFiles);
      this.connectTests(newFiles);
      
      index.files = newFiles;
      index.indexedAt = new Date().toISOString();
      await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf8");
    }
  }

  private async ensureIndex(): Promise<PersistedWorkspaceIndex> {
    const existing = await this.loadIndex();
    if (!existing) {
      return this.rebuild();
    }

    // Check for stale files incrementally
    const files = await collectIndexableFiles(this.workspaceRoot, 10000, this.workspaceRoot);
    const indexed = new Map(existing.files.map((record) => [record.path, record]));
    const stale: string[] = [];

    for (const absolutePath of files) {
      const rel = toPosixRelative(this.workspaceRoot, absolutePath);
      const stat = await fs.stat(absolutePath).catch(() => null);
      const record = indexed.get(rel);
      if (!stat?.isFile()) continue;
      if (!record || Math.floor(stat.mtimeMs) !== record.mtimeMs || stat.size !== record.size) {
        stale.push(rel);
      }
    }

    if (stale.length > 0) {
      // If many files are stale (> 25% or > 50 files), do a full rebuild for consistency
      if (stale.length > 50 || stale.length > files.length * 0.25) {
        return this.rebuild();
      }
      await this.partialUpdate(stale);
    }

    return this.cachedIndex!;
  }

  private async loadIndex(): Promise<PersistedWorkspaceIndex | null> {
    if (this.cachedIndex) return this.cachedIndex;
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedWorkspaceIndex;
      if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION || parsed.workspaceHash !== this.workspaceHash) {
        return null;
      }
      this.cachedIndex = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  private async buildRecord(
    absolutePath: string,
    relativePath: string,
    context: BuildContext
  ): Promise<IndexedFileRecord | null> {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > 1_500_000 || BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      return null;
    }

    const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
    if (!raw || raw.includes("\u0000")) return null;

    const lines = raw.split(/\r?\n/g);
    const detailed = await this.meshCore.getDetailedRecord(relativePath, raw);
    const imports = extractImports(raw);
    const exports = extractExports(raw);
    const dependencies = uniqueLimited(resolveDependencies(relativePath, imports, this.workspaceRoot), 100);
    const symbols = await this.symbolsFor(relativePath, raw, detailed?.symbols ?? []);
    const callSites = detailed?.callSites ?? [];
    const routes = extractRoutes(raw);
    const isTest = isTestFile(relativePath);
    const isDoc = isDocFile(relativePath);
    const sideEffects = detectSideEffects(raw);
    const risks = detectRisks(relativePath, raw);
    const purpose = inferPurpose(relativePath, raw, symbols, routes, isTest, isDoc);
    const git = await this.readGitHistory(relativePath, context.dirtyFiles);
    const capsule: StructuredCapsule = {
      purpose,
      exports,
      imports,
      symbols: symbols.slice(0, 60).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        lines: `L${symbol.lineStart}-L${symbol.lineEnd}`
      })),
      sideEffects,
      risks,
      testLinks: []
    };
    const chunks = await this.buildChunks(relativePath, raw, capsule, symbols, routes, isTest);
    const textVector = await this.vectorize([
      relativePath,
      purpose,
      exports.join(" "),
      imports.join(" "),
      symbols.map((symbol) => `${symbol.kind} ${symbol.name}`).join(" "),
      routes.map((route) => `${route.method} ${route.route}`).join(" "),
      risks.join(" "),
      sideEffects.join(" ")
    ].join("\n"));

    return {
      path: relativePath,
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      language: detectLanguage(relativePath),
      lineCount: lines.length,
      isTest,
      isDoc,
      imports,
      exports,
      dependencies,
      dependents: [],
      routes,
      symbols,
      callSites,
      git,
      capsule,
      chunks,
      textVector
    };
  }

  private async symbolsFor(relativePath: string, raw: string, meshSymbols: MeshSymbol[]): Promise<SymbolRecord[]> {
    const lines = raw.split(/\r?\n/g);
    const source = meshSymbols.length > 0 ? meshSymbols : fallbackSymbols(raw);
    return source.map((symbol) => ({
      ...symbol,
      signature: lines[Math.max(0, symbol.lineStart - 1)]?.trim()
    }));
  }

  private async readDirtyFiles(): Promise<Set<string>> {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd: this.workspaceRoot,
        maxBuffer: 1024 * 1024
      });
      return new Set(
        stdout
          .split(/\r?\n/g)
          .map((line) => line.slice(3).trim())
          .filter(Boolean)
          .map((line) => line.replace(/^"|"$/g, ""))
      );
    } catch {
      return new Set();
    }
  }

  private async readGitHistory(relativePath: string, dirtyFiles: Set<string>): Promise<GitFileHistory> {
    const dirty = dirtyFiles.has(relativePath);
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "-1", "--format=%h%x09%ad%x09%s", "--date=short", "--", relativePath],
        { cwd: this.workspaceRoot, maxBuffer: 128 * 1024 }
      );
      const [lastCommit, lastCommitDate, ...subjectParts] = stdout.trim().split("\t");
      return {
        lastCommit: lastCommit || undefined,
        lastCommitDate: lastCommitDate || undefined,
        lastCommitSubject: subjectParts.join("\t") || undefined,
        dirty
      };
    } catch {
      return { dirty };
    }
  }

  private connectDependents(records: IndexedFileRecord[]): void {
    const byPath = new Map(records.map((record) => [record.path, record]));
    for (const record of records) {
      for (const dep of record.dependencies) {
        const target = byPath.get(dep);
        if (target && !target.dependents.includes(record.path)) {
          target.dependents.push(record.path);
        }
      }
    }
  }

  private connectTests(records: IndexedFileRecord[]): void {
    const tests = records.filter((record) => record.isTest);
    for (const record of records) {
      if (record.isTest) continue;
      const linked = tests
        .filter((test) => fuzzyTestMatch(test.path, record.path))
        .map((test) => test.path);
      record.capsule.testLinks = uniqueLimited(linked, 20);
    }
  }
}

async function loadIgnoreFilter(workspaceRoot: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(DEFAULT_SKIP_DIRS);
  try {
    const gitignorePath = path.join(workspaceRoot, ".gitignore");
    if (existsSync(gitignorePath)) {
      const content = await fs.readFile(gitignorePath, "utf8");
      ig.add(content);
    }
  } catch {
    // Ignore if not readable
  }
  return ig;
}

async function collectIndexableFiles(start: string, limit: number, root?: string): Promise<string[]> {
  const workspaceRoot = root || start;
  const ig = await loadIgnoreFilter(workspaceRoot);
  const queue = [path.resolve(start)];
  const files: string[] = [];

  while (queue.length > 0 && files.length < limit) {
    const current = queue.shift();
    if (!current) break;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (files.length >= limit) break;

      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");

      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (ig.ignores(relativePath)) continue;

      if (entry.isDirectory()) {
        queue.push(absolutePath);
      } else if (entry.isFile() && isIndexableExtension(absolutePath)) {
        files.push(absolutePath);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function isIndexableExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (!ext) return true;
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".mdx",
    ".css",
    ".scss",
    ".html",
    ".yml",
    ".yaml",
    ".toml",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".sh"
  ].includes(ext);
}

function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function normalizeRelPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function parseIntegerInRange(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_.$/-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

let embeddingPipeline: any = null;
async function getEmbeddingPipeline() {
  if (isRemoteEmbeddingModel(DEFAULT_EMBEDDING_MODEL)) {
    return null;
  }
  if (!embeddingPipeline) {
    try {
      embeddingPipeline = await pipeline("feature-extraction", DEFAULT_EMBEDDING_MODEL, {
        quantized: true
      });
    } catch {
      embeddingPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        quantized: true
      });
    }
  }
  return embeddingPipeline;
}

function isRemoteEmbeddingModel(modelId: string): boolean {
  return isNvidiaHostedModel(modelId) || modelId === "snowflake/arctic-embed-l";
}

function cosine(left: number[], right: number[]): number {
  if (!left || !right || left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
  }
  return dot;
}

function scoreKeywordMatches(record: IndexedFileRecord, queryTokens: string[], signals: string[]): number {
  let score = 0;
  const pathText = record.path.toLowerCase();
  const purposeText = record.capsule.purpose.toLowerCase();
  const symbolText = record.symbols.map((symbol) => symbol.name.toLowerCase()).join(" ");
  const importText = record.imports.join(" ").toLowerCase();

  for (const token of queryTokens) {
    if (pathText.includes(token)) {
      score += 3;
      signals.push(`path:${token}`);
    }
    if (symbolText.includes(token)) {
      score += 2.5;
      signals.push(`symbol:${token}`);
    }
    if (purposeText.includes(token)) {
      score += 1.5;
      signals.push(`purpose:${token}`);
    }
    if (importText.includes(token)) {
      score += 1;
      signals.push(`import:${token}`);
    }
  }

  return score;
}

function scoreModeSignals(
  record: IndexedFileRecord,
  mode: CodeQueryMode,
  query: string,
  queryTokens: string[],
  signals: string[]
): number {
  let score = 0;
  if (mode === "architecture") {
    if (record.dependencies.length > 0) score += 1;
    if (record.exports.length > 0) score += 1;
    if (record.isDoc) score += 1.2;
    signals.push("mode:architecture");
  }
  if (mode === "bug") {
    if (record.capsule.risks.length > 0) score += 2;
    if (record.git.dirty) score += 1;
    if (/error|fail|throw|catch|diagnostic|bug/i.test(record.capsule.purpose)) score += 1.5;
    signals.push("mode:bug");
  }
  if (mode === "edit-impact" || mode === "test-impact") {
    score += Math.min(4, record.dependents.length * 0.6);
    score += Math.min(3, record.capsule.testLinks.length * 0.8);
    signals.push(`mode:${mode}`);
  }
  if (mode === "ownership" || mode === "recent-change") {
    if (record.git.lastCommit) score += 1.5;
    if (record.git.dirty) score += 3;
    signals.push(`mode:${mode}`);
  }
  if (mode === "runtime-path") {
    if (record.routes.length > 0) score += 3;
    if (record.callSites.length > 0) score += 0.75;
    signals.push("mode:runtime-path");
  }
  if (queryTokens.some((token) => query.toLowerCase().includes(`${token} tests`)) && record.isTest) {
    score += 2;
  }
  return score;
}

function bestSymbolCitation(record: IndexedFileRecord, queryTokens: string[]): CodeCitation | null {
  const symbol = record.symbols.find((entry) =>
    queryTokens.some((token) => entry.name.toLowerCase().includes(token) || entry.kind.toLowerCase().includes(token))
  );
  if (!symbol) return null;
  return {
    file: record.path,
    symbol: symbol.name,
    lines: { start: symbol.lineStart, end: symbol.lineEnd },
    confidence: 0.82,
    whyMatched: [`symbol ${symbol.kind} ${symbol.name}`]
  };
}

function bestRouteCitation(record: IndexedFileRecord, queryTokens: string[]): CodeCitation | null {
  const route = record.routes.find((entry) =>
    queryTokens.some((token) => entry.route.toLowerCase().includes(token) || entry.method.toLowerCase() === token)
  );
  if (!route) return null;
  return {
    file: record.path,
    lines: { start: route.line, end: route.line },
    confidence: 0.8,
    whyMatched: [`route ${route.method.toUpperCase()} ${route.route}`]
  };
}

function confidenceFromScore(score: number): number {
  return Number(Math.max(0.2, Math.min(0.97, score / 14)).toFixed(2));
}

function citationForFile(record: IndexedFileRecord, whyMatched: string[], confidence: number): CodeCitation {
  return {
    file: record.path,
    lines: { start: 1, end: Math.min(record.lineCount, 60) },
    confidence,
    whyMatched
  };
}

function uniqueLimited(values: string[], limit: number): string[] {
  return Array.from(new Set(values.filter(Boolean))).slice(0, limit);
}

function extractImports(raw: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /export\s+[^'"]+\s+from\s+["']([^"']+)["']/g,
    /require\(["']([^"']+)["']\)/g,
    /import\(["']([^"']+)["']\)/g
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      imports.add(match[1]);
    }
  }
  return Array.from(imports).slice(0, 200);
}

function extractExports(raw: string): string[] {
  const exports = new Set<string>();
  const patterns = [
    /export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /export\s*\{([^}]+)\}/g
  ];
  for (const match of raw.matchAll(patterns[0])) {
    exports.add(match[1]);
  }
  for (const match of raw.matchAll(patterns[1])) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/i)[0]?.trim();
      if (name) exports.add(name);
    }
  }
  return Array.from(exports).slice(0, 120);
}

function resolveDependencies(relativePath: string, imports: string[], workspaceRoot: string): string[] {
  const fromDir = path.posix.dirname(relativePath);
  return imports
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => {
      const joined = path.posix.normalize(path.posix.join(fromDir, specifier));
      const ext = path.posix.extname(joined);
      const withoutExt = ext ? joined.slice(0, -ext.length) : joined;
      const candidates = [
        joined,
        ext === ".js" ? `${withoutExt}.ts` : "",
        ext === ".js" ? `${withoutExt}.tsx` : "",
        ext === ".jsx" ? `${withoutExt}.tsx` : "",
        `${joined}.ts`,
        `${joined}.tsx`,
        `${joined}.js`,
        `${joined}.jsx`,
        `${joined}.mjs`,
        `${joined}.cjs`,
        path.posix.join(joined, "index.ts"),
        path.posix.join(joined, "index.tsx"),
        path.posix.join(joined, "index.js")
      ];
      return candidates.filter(Boolean).find((candidate) => existsSync(path.join(workspaceRoot, candidate))) ?? joined;
    })
    .map(normalizeRelPath);
}

function extractRoutes(raw: string): RouteRecord[] {
  const routes: RouteRecord[] = [];
  const lines = raw.split(/\r?\n/g);
  const routePattern = /\b(?:app|router|server|fastify)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*["'`]([^"'`]+)["'`]/i;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(routePattern);
    if (match) {
      routes.push({
        method: match[1].toLowerCase(),
        route: match[2],
        line: index + 1
      });
    }
  }
  return routes;
}

function fallbackSymbols(raw: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const lines = raw.split(/\r?\n/g);
  const patterns = [
    { kind: "function", regex: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "class", regex: /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "const", regex: /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: "type", regex: /\b(?:export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/ }
  ];
  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of patterns) {
      const match = lines[index].match(pattern.regex);
      if (match) {
        symbols.push({
          name: match[1],
          kind: pattern.kind,
          lineStart: index + 1,
          lineEnd: findBlockEnd(lines, index),
          signature: lines[index].trim()
        });
      }
    }
  }
  return symbols.slice(0, 200);
}

function findBlockEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (index > startIndex && depth <= 0) return index + 1;
  }
  return Math.min(lines.length, startIndex + 1);
}

function detectSideEffects(raw: string): string[] {
  const effects: string[] = [];
  if (/\bfs\.(write|append|unlink|rename|mkdir|rm)|writeFile|unlink\(/.test(raw)) effects.push("filesystem writes");
  if (/\bspawn\(|\bexec\(|execFile\(/.test(raw)) effects.push("subprocess execution");
  if (/\bfetch\(|axios\.|http\.request|https\.request/.test(raw)) effects.push("network calls");
  if (/process\.env/.test(raw)) effects.push("environment reads");
  if (/process\.exit|SIGTERM|SIGKILL/.test(raw)) effects.push("process control");
  return effects;
}

function detectRisks(relativePath: string, raw: string): string[] {
  const risks: string[] = [];
  if (/\bexec\(\s*`|\bexec\(\s*["'].*\$\{/.test(raw)) risks.push("shell interpolation");
  if (/AWS_|TOKEN|SECRET|API_KEY|bearerToken/i.test(raw)) risks.push("secret-bearing code path");
  if (/rm\s+-rf|unlink|delete_file/.test(raw)) risks.push("destructive file operation");
  if (/auth|login|token|credential/i.test(relativePath)) risks.push("authentication surface");
  if (/dashboard|html|innerHTML|script/i.test(raw)) risks.push("UI/script injection surface");
  return risks;
}

function inferPurpose(
  relativePath: string,
  raw: string,
  symbols: SymbolRecord[],
  routes: RouteRecord[],
  isTest: boolean,
  isDoc: boolean
): string {
  if (isDoc) {
    const heading = raw.match(/^#\s+(.+)$/m)?.[1];
    return heading ? `Documentation: ${heading}` : "Documentation file";
  }
  if (isTest) return `Test file covering ${path.basename(relativePath)}`;
  if (routes.length > 0) {
    return `Runtime/API module exposing ${routes.slice(0, 4).map((route) => `${route.method.toUpperCase()} ${route.route}`).join(", ")}`;
  }
  if (symbols.length > 0) {
    return `Defines ${symbols.slice(0, 6).map((symbol) => `${symbol.kind} ${symbol.name}`).join(", ")}`;
  }
  const firstComment = raw.match(/^\s*(?:\/\*\*?\s*([\s\S]*?)\*\/|\/\/\s*(.+))/)?.[1]?.trim();
  return firstComment ? firstComment.replace(/\s+/g, " ").slice(0, 240) : `Source file ${relativePath}`;
}

function detectLanguage(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript-react",
    ".js": "javascript",
    ".jsx": "javascript-react",
    ".json": "json",
    ".md": "markdown",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".css": "css",
    ".html": "html",
    ".sh": "shell"
  };
  return map[ext] ?? ext.replace(/^\./, "") ?? "text";
}

function isTestFile(relativePath: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(relativePath);
}

function isDocFile(relativePath: string): boolean {
  return /\.(md|mdx)$/i.test(relativePath) || /(^|\/)docs?\//i.test(relativePath);
}

function fuzzyTestMatch(testPath: string, sourcePath: string): boolean {
  const sourceBase = path.basename(sourcePath).replace(/\.[^.]+$/, "").toLowerCase();
  const testBase = path.basename(testPath).toLowerCase();
  if (!sourceBase || sourceBase.length < 3) return false;
  return testBase.includes(sourceBase);
}

function extractPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^\+\+\+\s+b\/(.+)$/gm)) {
    if (match[1] !== "/dev/null") paths.add(match[1]);
  }
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    paths.add(match[2]);
  }
  return Array.from(paths);
}
