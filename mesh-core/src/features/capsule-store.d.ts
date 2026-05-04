/**
 * SessionCapsuleStore - Persistent code context caching
 * Generates multi-tier summaries (Low/Medium/High) with smart invalidation
 */
import type { CapsuleTier, CapsuleMetadata } from "./types.js";
export interface CapsuleStoreConfig {
    workspaceRoot: string;
    cacheDir?: string;
    maxCacheSize?: number;
    invalidationThreshold?: number;
}
export interface GeneratedCapsule {
    path: string;
    tier: CapsuleTier;
    content: string;
    metadata: CapsuleMetadata;
    tokenCount: number;
}
export declare class SessionCapsuleStore {
    private config;
    private cacheDir;
    private metadata;
    private contentHash;
    constructor(config: CapsuleStoreConfig);
    private ensureCacheDir;
    private loadMetadata;
    private saveMetadata;
    private hashContent;
    private estimateTokenCount;
    /**
     * Generate a Low tier capsule (symbols only, ~2KB)
     */
    generateLowTier(filePath: string, content: string): GeneratedCapsule;
    /**
     * Generate a Medium tier capsule (functions + types, ~8KB)
     */
    generateMediumTier(filePath: string, content: string): GeneratedCapsule;
    /**
     * Generate a High tier capsule (full context with imports/exports, ~32KB)
     */
    generateHighTier(filePath: string, content: string): GeneratedCapsule;
    /**
     * Extract function/class names
     */
    private extractSymbols;
    /**
     * Extract type definitions
     */
    private extractTypes;
    /**
     * Extract function signatures
     */
    private extractFunctions;
    /**
     * Save capsule to cache
     */
    saveCapsule(capsule: GeneratedCapsule): string;
    /**
     * Check if cached capsule is still valid
     */
    isCacheValid(filePath: string, currentContent: string): boolean;
    /**
     * Load capsule from cache
     */
    loadCapsule(filePath: string, tier: CapsuleTier): GeneratedCapsule | null;
    /**
     * Clear old capsules when cache exceeds limit
     */
    pruneCache(): void;
    /**
     * Get cache statistics
     */
    getStats(): {
        cacheSize: number;
        fileCount: number;
        metadata: {
            [k: string]: CapsuleMetadata;
        };
    };
    private generateFileName;
}
