/**
 * Impact Analyzer - Wave 1 Feature
 * Analyzes the impact of changing specific symbols on the codebase
 *
 * Used by: CLI, IDE (REST API), MCP (tools)
 */
import path from "node:path";
import { promises as fs } from "node:fs";
export class ImpactAnalyzer {
    workspaceRoot;
    maxDepth;
    symbolIndex = new Map();
    usageIndex = new Map();
    testFiles = new Set();
    constructor(options) {
        this.workspaceRoot = options.workspaceRoot;
        this.maxDepth = options.maxDepth ?? 3;
    }
    /**
     * Analyze impact of changing symbols
     */
    async analyze(query) {
        const startTime = Date.now();
        // Build indices if needed
        await this.ensureIndexed();
        const impacts = [];
        const affectedFiles = new Set();
        for (const symbol of query.symbols) {
            // Find definitions
            const defs = this.symbolIndex.get(symbol) || [];
            for (const def of defs) {
                if (query.files && !query.files.includes(def.path)) {
                    continue;
                }
                affectedFiles.add(def.path);
                // Find all usages of this symbol
                const usages = await this.findUsages(symbol, def.path, query.depth ?? this.maxDepth);
                for (const usage of usages) {
                    if (usage.type === "test") {
                        impacts.push({
                            path: usage.path,
                            symbol,
                            type: "test",
                            severity: "critical",
                            reason: `Test depends on ${symbol}`
                        });
                    }
                    else if (usage.type === "usage") {
                        impacts.push({
                            path: usage.path,
                            symbol,
                            type: "usage",
                            severity: this.calculateSeverity(usage.path),
                            reason: `${usage.path} uses ${symbol}`
                        });
                        affectedFiles.add(usage.path);
                    }
                    else if (usage.type === "import") {
                        impacts.push({
                            path: usage.path,
                            symbol,
                            type: "dependent",
                            severity: "high",
                            reason: `${usage.path} imports ${symbol}`
                        });
                        affectedFiles.add(usage.path);
                    }
                }
            }
        }
        const executionTimeMs = Date.now() - startTime;
        const riskLevel = this.assessRiskLevel(impacts, affectedFiles);
        return {
            symbols: query.symbols,
            impacts,
            affectedFiles,
            riskLevel,
            executionTimeMs
        };
    }
    /**
     * Find all usages of a symbol
     */
    async findUsages(symbol, definitionPath, depth) {
        const usages = [];
        const visited = new Set();
        const queue = [{ path: definitionPath, depth: 0 }];
        // Quick regex search for symbol references
        const symbolRegex = new RegExp(`\\b${this.escapeRegex(symbol)}\\b`, "g");
        const allFiles = await this.collectFiles();
        for (const filePath of allFiles) {
            if (visited.has(filePath))
                continue;
            visited.add(filePath);
            try {
                const content = await fs.readFile(filePath, "utf8");
                const lines = content.split("\n");
                const isTestFile = this.isTestFile(filePath);
                for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                    const line = lines[lineIdx];
                    if (symbolRegex.test(line)) {
                        // Determine usage type
                        let type = "usage";
                        if (isTestFile) {
                            type = "test";
                        }
                        else if (line.includes("import") || line.includes("require")) {
                            type = "import";
                        }
                        usages.push({
                            path: path.relative(this.workspaceRoot, filePath).split(path.sep).join("/"),
                            symbol,
                            line: lineIdx + 1,
                            type
                        });
                    }
                }
            }
            catch {
                // Skip files we can't read
            }
        }
        return usages;
    }
    /**
     * Ensure workspace is indexed
     */
    async ensureIndexed() {
        if (this.symbolIndex.size > 0)
            return;
        const files = await this.collectFiles();
        const jsTypeRegex = /^\s*(export\s+)?(async\s+)?(function|const|let|var|class|interface|type)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/;
        const testFileRegex = /(\.test\.|\.spec\.|__tests__|test\/)/;
        for (const filePath of files) {
            try {
                const content = await fs.readFile(filePath, "utf8");
                const lines = content.split("\n");
                const relPath = path.relative(this.workspaceRoot, filePath).split(path.sep).join("/");
                if (testFileRegex.test(relPath)) {
                    this.testFiles.add(relPath);
                }
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const match = line.match(jsTypeRegex);
                    if (match) {
                        const symbolName = match[4];
                        const symbolType = (match[3] === "function"
                            ? "function"
                            : match[3] === "class"
                                ? "class"
                                : match[3] === "interface"
                                    ? "interface"
                                    : match[3] === "type"
                                        ? "type"
                                        : "variable");
                        if (!this.symbolIndex.has(symbolName)) {
                            this.symbolIndex.set(symbolName, []);
                        }
                        this.symbolIndex.get(symbolName).push({
                            path: relPath,
                            symbol: symbolName,
                            line: i + 1,
                            type: symbolType
                        });
                    }
                }
            }
            catch {
                // Skip files we can't read
            }
        }
    }
    /**
     * Collect all files in workspace
     */
    async collectFiles() {
        const skipDirs = new Set([".git", "node_modules", ".next", "dist", ".mesh", "build", "coverage"]);
        const skipExtensions = new Set([".png", ".jpg", ".gif", ".zip", ".pdf", ".wasm"]);
        const results = [];
        const walk = async (dir) => {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (!skipDirs.has(entry.name)) {
                            await walk(fullPath);
                        }
                    }
                    else if (entry.isFile()) {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (!skipExtensions.has(ext)) {
                            results.push(fullPath);
                        }
                    }
                }
            }
            catch {
                // Skip directories we can't read
            }
        };
        await walk(this.workspaceRoot);
        return results;
    }
    isTestFile(filePath) {
        const relPath = path.relative(this.workspaceRoot, filePath);
        return this.testFiles.has(relPath) || /(\.test\.|\.spec\.|__tests__|test\/)/i.test(relPath);
    }
    calculateSeverity(filePath) {
        // Simple heuristic
        if (this.isTestFile(filePath))
            return "critical";
        if (filePath.includes("src/") || filePath.includes("lib/"))
            return "high";
        if (filePath.includes("utils") || filePath.includes("helpers"))
            return "medium";
        return "low";
    }
    assessRiskLevel(impacts, affectedFiles) {
        const criticalCount = impacts.filter(i => i.severity === "critical").length;
        const highCount = impacts.filter(i => i.severity === "high").length;
        if (criticalCount > 0)
            return "danger";
        if (highCount > 3 || affectedFiles.size > 20)
            return "caution";
        return "safe";
    }
    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
}
