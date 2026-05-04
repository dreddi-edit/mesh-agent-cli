/**
 * Shared RAG Engine - Wave 1 Feature
 * Provides workspace code search via keyword + optional semantic matching
 *
 * Used by: CLI, IDE (REST API), MCP (tools)
 */
import type { RAGQuery, RAGResult } from "./types.js";
export interface RAGEngineOptions {
    workspaceRoot: string;
    enableSemanticSearch?: boolean;
    embeddingModel?: string;
    maxResults?: number;
}
export declare class RAGEngine {
    private workspaceRoot;
    private enableSemanticSearch;
    private embeddingModel;
    private maxResults;
    private fileIndex;
    private vectorCache;
    constructor(options: RAGEngineOptions);
    /**
     * Query the workspace with RAG
     */
    query(input: RAGQuery): Promise<RAGResult>;
    /**
     * Keyword-based search (BM25-inspired)
     */
    private keywordSearch;
    /**
     * Semantic search (optional, requires @xenova/transformers)
     */
    private semanticSearch;
    /**
     * Extract keywords from natural language query
     */
    private extractKeywords;
    /**
     * Ensure workspace is indexed
     */
    private ensureIndexed;
    /**
     * Collect all indexable files
     */
    private collectFiles;
    /**
     * Merge keyword and semantic results
     */
    private mergeResults;
    private hashContent;
    private escapeRegex;
}
