/**
 * SessionCapsuleStore - Persistent code context caching
 * Generates multi-tier summaries (Low/Medium/High) with smart invalidation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  CapsuleTier,
  CapsuleMetadata,
  CapsuleContent
} from './types';

export interface CapsuleStoreConfig {
  workspaceRoot: string;
  cacheDir?: string;
  maxCacheSize?: number; // MB
  invalidationThreshold?: number; // 0.95 = 95% similarity
}

export interface GeneratedCapsule {
  path: string;
  tier: CapsuleTier;
  content: string;
  metadata: CapsuleMetadata;
  tokenCount: number;
}

export class SessionCapsuleStore {
  private config: CapsuleStoreConfig;
  private cacheDir: string;
  private metadata: Map<string, CapsuleMetadata> = new Map();
  private contentHash: Map<string, string> = new Map();

  constructor(config: CapsuleStoreConfig) {
    this.config = {
      maxCacheSize: 500,
      invalidationThreshold: 0.95,
      ...config
    };
    
    this.cacheDir = config.cacheDir || path.join(config.workspaceRoot, '.mesh', 'capsules');
    this.ensureCacheDir();
    this.loadMetadata();
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private loadMetadata(): void {
    const metaFile = path.join(this.cacheDir, '_metadata.json');
    if (fs.existsSync(metaFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
        Object.entries(data).forEach(([key, value]: [string, any]) => {
          this.metadata.set(key, value);
        });
      } catch (err) {
        // Ignore corrupt metadata
      }
    }
  }

  private saveMetadata(): void {
    const data = Object.fromEntries(this.metadata);
    fs.writeFileSync(
      path.join(this.cacheDir, '_metadata.json'),
      JSON.stringify(data, null, 2)
    );
  }

  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private estimateTokenCount(content: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(content.length / 4);
  }

  /**
   * Generate a Low tier capsule (symbols only, ~2KB)
   */
  generateLowTier(filePath: string, content: string): GeneratedCapsule {
    const symbols = this.extractSymbols(content);
    const summary = `# ${path.basename(filePath)}\n\n## Symbols\n${symbols.join('\n')}`;

    return {
      path: filePath,
      tier: 'low',
      content: summary,
      metadata: {
        filePath,
        tier: 'low',
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
  generateMediumTier(filePath: string, content: string): GeneratedCapsule {
    const symbols = this.extractSymbols(content);
    const types = this.extractTypes(content);
    const functions = this.extractFunctions(content);

    const summary = `# ${path.basename(filePath)}\n
## Types
${types.join('\n')}

## Functions
${functions.slice(0, 10).map(f => `- ${f}`).join('\n')}

## Exports
${symbols.join(', ')}`;

    return {
      path: filePath,
      tier: 'medium',
      content: summary,
      metadata: {
        filePath,
        tier: 'medium',
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
  generateHighTier(filePath: string, content: string): GeneratedCapsule {
    const summary = `# ${path.basename(filePath)}\n\n${content.slice(0, 8000)}...`;

    return {
      path: filePath,
      tier: 'high',
      content: summary,
      metadata: {
        filePath,
        tier: 'high',
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
  private extractSymbols(content: string): string[] {
    const patterns = [
      /export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g,
      /class\s+(\w+)/g,
      /interface\s+(\w+)/g,
      /type\s+(\w+)\s*=/g
    ];

    const symbols = new Set<string>();
    patterns.forEach(pattern => {
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
  private extractTypes(content: string): string[] {
    const typePattern = /(?:interface|type)\s+(\w+)(?:\s*=\s*|\s*\{)([^}]*(?:\{[^}]*\}[^}]*)*)/g;
    const types: string[] = [];
    let match;

    while ((match = typePattern.exec(content)) !== null) {
      const typeName = match[1];
      const firstLine = match[2].split('\n')[0];
      types.push(`- **${typeName}**: ${firstLine.trim().slice(0, 60)}`);
    }

    return types;
  }

  /**
   * Extract function signatures
   */
  private extractFunctions(content: string): string[] {
    const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
    const functions: string[] = [];
    let match;

    while ((match = funcPattern.exec(content)) !== null) {
      functions.push(`${match[1]}(${match[2].split(',').length} params)`);
    }

    return functions;
  }

  /**
   * Save capsule to cache
   */
  saveCapsule(capsule: GeneratedCapsule): string {
    const fileName = this.generateFileName(capsule.path, capsule.tier);
    const filePath = path.join(this.cacheDir, fileName);

    fs.writeFileSync(filePath, capsule.content, 'utf-8');
    this.metadata.set(fileName, capsule.metadata);
    this.contentHash.set(capsule.path, capsule.metadata.contentHash);
    this.saveMetadata();

    return filePath;
  }

  /**
   * Check if cached capsule is still valid
   */
  isCacheValid(filePath: string, currentContent: string): boolean {
    const hash = this.hashContent(currentContent);
    const cachedHash = this.contentHash.get(filePath);

    if (!cachedHash) return false;

    // Simple hash comparison; could use similarity scoring
    return cachedHash === hash;
  }

  /**
   * Load capsule from cache
   */
  loadCapsule(filePath: string, tier: CapsuleTier): GeneratedCapsule | null {
    const fileName = this.generateFileName(filePath, tier);
    const fileCachePath = path.join(this.cacheDir, fileName);
    const meta = this.metadata.get(fileName);

    if (!fs.existsSync(fileCachePath) || !meta) {
      return null;
    }

    return {
      path: filePath,
      tier,
      content: fs.readFileSync(fileCachePath, 'utf-8'),
      metadata: meta,
      tokenCount: this.estimateTokenCount(fs.readFileSync(fileCachePath, 'utf-8'))
    };
  }

  /**
   * Clear old capsules when cache exceeds limit
   */
  pruneCache(): void {
    const files = fs.readdirSync(this.cacheDir).filter(f => f !== '_metadata.json');
    let totalSize = 0;

    files.forEach(file => {
      const filePath = path.join(this.cacheDir, file);
      totalSize += fs.statSync(filePath).size / 1024 / 1024;
    });

    if (totalSize > (this.config.maxCacheSize || 500)) {
      // Remove oldest files
      const sorted = files
        .map(f => ({
          name: f,
          time: fs.statSync(path.join(this.cacheDir, f)).mtime.getTime()
        }))
        .sort((a, b) => a.time - b.time);

      let freed = 0;
      for (const file of sorted) {
        const filePath = path.join(this.cacheDir, file.name);
        freed += fs.statSync(filePath).size / 1024 / 1024;
        fs.unlinkSync(filePath);

        if (freed > (this.config.maxCacheSize || 500) / 2) break;
      }

      this.saveMetadata();
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const files = fs.readdirSync(this.cacheDir).filter(f => f !== '_metadata.json');
    let totalSize = 0;

    files.forEach(file => {
      totalSize += fs.statSync(path.join(this.cacheDir, file)).size;
    });

    return {
      cacheSize: totalSize / 1024,
      fileCount: files.length,
      metadata: Object.fromEntries(this.metadata)
    };
  }

  private generateFileName(filePath: string, tier: CapsuleTier): string {
    const hash = crypto.createHash('md5').update(filePath).digest('hex');
    return `${hash}_${tier}.capsule`;
  }
}
