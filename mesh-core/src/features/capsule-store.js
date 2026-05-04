/**
 * SessionCapsuleStore - Persistent code context caching
 * Generates multi-tier summaries (Low/Medium/High) with smart invalidation
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
export class SessionCapsuleStore {
    config;
    cacheDir;
    metadata = new Map();
    contentHash = new Map();
    constructor(config) {
        this.config = {
            maxCacheSize: 500,
            invalidationThreshold: 0.95,
            ...config
        };
        this.cacheDir = config.cacheDir || path.join(config.workspaceRoot, ".mesh", "capsules");
        this.ensureCacheDir();
        this.loadMetadata();
    }
    ensureCacheDir() {
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }
    loadMetadata() {
        const metaFile = path.join(this.cacheDir, "_metadata.json");
        if (fs.existsSync(metaFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
                Object.entries(data).forEach(([key, value]) => {
                    this.metadata.set(key, value);
                });
            }
            catch (_err) {
            }
        }
    }
    saveMetadata() {
        const data = Object.fromEntries(this.metadata);
        fs.writeFileSync(path.join(this.cacheDir, "_metadata.json"), JSON.stringify(data, null, 2));
    }
    hashContent(content) {
        return crypto.createHash("sha256").update(content).digest("hex");
    }
    estimateTokenCount(content) {
        return Math.ceil(content.length / 4);
    }
    /**
     * Generate a Low tier capsule (symbols only, ~2KB)
     */
    generateLowTier(filePath, content) {
        const symbols = this.extractSymbols(content);
        const summary = `# ${path.basename(filePath)}\n\n## Symbols\n${symbols.join("\n")}`;
        return {
            path: filePath,
            tier: "low",
            content: summary,
            metadata: {
                filePath,
                tier: "low",
                createdAt: new Date(),
                contentHash: this.hashContent(content),
                originalSize: content.length,
                compressedSize: summary.length
            },
            tokenCount: this.estimateTokenCount(summary)
        };
    }
    /**
     * Generate a Medium tier capsule (functions + types, ~8KB)
     */
    generateMediumTier(filePath, content) {
        const symbols = this.extractSymbols(content);
        const types = this.extractTypes(content);
        const functions = this.extractFunctions(content);
        const summary = `# ${path.basename(filePath)}\n
## Types
${types.join("\n")}

## Functions
${functions.slice(0, 10).map((f) => `- ${f}`).join("\n")}

## Exports
${symbols.join(", ")}`;
        return {
            path: filePath,
            tier: "medium",
            content: summary,
            metadata: {
                filePath,
                tier: "medium",
                createdAt: new Date(),
                contentHash: this.hashContent(content),
                originalSize: content.length,
                compressedSize: summary.length
            },
            tokenCount: this.estimateTokenCount(summary)
        };
    }
    /**
     * Generate a High tier capsule (full context with imports/exports, ~32KB)
     */
    generateHighTier(filePath, content) {
        const summary = `# ${path.basename(filePath)}\n\n${content.slice(0, 8000)}...`;
        return {
            path: filePath,
            tier: "high",
            content: summary,
            metadata: {
                filePath,
                tier: "high",
                createdAt: new Date(),
                contentHash: this.hashContent(content),
                originalSize: content.length,
                compressedSize: summary.length
            },
            tokenCount: this.estimateTokenCount(summary)
        };
    }
    /**
     * Extract function/class names
     */
    extractSymbols(content) {
        const patterns = [
            /export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g,
            /class\s+(\w+)/g,
            /interface\s+(\w+)/g,
            /type\s+(\w+)\s*=/g
        ];
        const symbols = new Set();
        patterns.forEach((pattern) => {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                symbols.add(match[1]);
            }
        });
        return Array.from(symbols).sort();
    }
    /**
     * Extract type definitions
     */
    extractTypes(content) {
        const typePattern = /(?:interface|type)\s+(\w+)(?:\s*=\s*|\s*\{)([^}]*(?:\{[^}]*\}[^}]*)*)/g;
        const types = [];
        let match;
        while ((match = typePattern.exec(content)) !== null) {
            const typeName = match[1];
            const firstLine = match[2].split("\n")[0];
            types.push(`- **${typeName}**: ${firstLine.trim().slice(0, 60)}`);
        }
        return types;
    }
    /**
     * Extract function signatures
     */
    extractFunctions(content) {
        const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
        const functions = [];
        let match;
        while ((match = funcPattern.exec(content)) !== null) {
            functions.push(`${match[1]}(${match[2].split(",").length} params)`);
        }
        return functions;
    }
    /**
     * Save capsule to cache
     */
    saveCapsule(capsule) {
        const fileName = this.generateFileName(capsule.path, capsule.tier);
        const filePath = path.join(this.cacheDir, fileName);
        fs.writeFileSync(filePath, capsule.content, "utf-8");
        this.metadata.set(fileName, capsule.metadata);
        this.contentHash.set(capsule.path, capsule.metadata.contentHash);
        this.saveMetadata();
        return filePath;
    }
    /**
     * Check if cached capsule is still valid
     */
    isCacheValid(filePath, currentContent) {
        const hash = this.hashContent(currentContent);
        const cachedHash = this.contentHash.get(filePath);
        if (!cachedHash)
            return false;
        return cachedHash === hash;
    }
    /**
     * Load capsule from cache
     */
    loadCapsule(filePath, tier) {
        const fileName = this.generateFileName(filePath, tier);
        const fileCachePath = path.join(this.cacheDir, fileName);
        const meta = this.metadata.get(fileName);
        if (!fs.existsSync(fileCachePath) || !meta) {
            return null;
        }
        const content = fs.readFileSync(fileCachePath, "utf-8");
        return {
            path: filePath,
            tier,
            content,
            metadata: meta,
            tokenCount: this.estimateTokenCount(content)
        };
    }
    /**
     * Clear old capsules when cache exceeds limit
     */
    pruneCache() {
        const files = fs.readdirSync(this.cacheDir).filter((f) => f !== "_metadata.json");
        let totalSize = 0;
        files.forEach((file) => {
            const filePath = path.join(this.cacheDir, file);
            totalSize += fs.statSync(filePath).size / 1024 / 1024;
        });
        if (totalSize > (this.config.maxCacheSize || 500)) {
            const sorted = files
                .map((f) => ({
                name: f,
                time: fs.statSync(path.join(this.cacheDir, f)).mtime.getTime()
            }))
                .sort((a, b) => a.time - b.time);
            let freed = 0;
            for (const file of sorted) {
                const filePath = path.join(this.cacheDir, file.name);
                freed += fs.statSync(filePath).size / 1024 / 1024;
                fs.unlinkSync(filePath);
                if (freed > (this.config.maxCacheSize || 500) / 2)
                    break;
            }
            this.saveMetadata();
        }
    }
    /**
     * Get cache statistics
     */
    getStats() {
        const files = fs.readdirSync(this.cacheDir).filter((f) => f !== "_metadata.json");
        let totalSize = 0;
        files.forEach((file) => {
            totalSize += fs.statSync(path.join(this.cacheDir, file)).size;
        });
        return {
            cacheSize: totalSize / 1024,
            fileCount: files.length,
            metadata: Object.fromEntries(this.metadata)
        };
    }
    generateFileName(filePath, tier) {
        const hash = crypto.createHash("md5").update(filePath).digest("hex");
        return `${hash}_${tier}.capsule`;
    }
}
