/**
 * Shared RAG Engine - Wave 1 Feature
 * Provides workspace code search via keyword + optional semantic matching
 * 
 * Used by: CLI, IDE (REST API), MCP (tools)
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { RAGQuery, RAGResult, RAGMatch, RAGMode } from "./types.js";

export interface RAGEngineOptions {
  workspaceRoot: string;
  enableSemanticSearch?: boolean;
  embeddingModel?: string;
  maxResults?: number;
}

interface IndexedFile {
  path: string;
  content: string;
  contentHash: string;
  lines: string[];
}

interface SearchContext {
  keywords: string[];
  mode: RAGMode;
  limit: number;
}

export class RAGEngine {
  private workspaceRoot: string;
  private enableSemanticSearch: boolean;
  private embeddingModel: string;
  private maxResults: number;
  private fileIndex: Map<string, IndexedFile> = new Map();
  private vectorCache: Map<string, number[]> = new Map();

  constructor(options: RAGEngineOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.enableSemanticSearch = options.enableSemanticSearch ?? false;
    this.embeddingModel = options.embeddingModel ?? "Xenova/nomic-embed-code";
    this.maxResults = options.maxResults ?? 50;
  }

  /**
   * Query the workspace with RAG
   */
  async query(input: RAGQuery): Promise<RAGResult> {
    const startTime = Date.now();
    const mode = input.mode ?? "architecture";
    const limit = Math.min(input.limit ?? 8, this.maxResults);

    // Extract keywords from query
    const keywords = this.extractKeywords(input.query);
    
    // Ensure we have indexed files
    await this.ensureIndexed();

    // Search using keyword-based approach (always available)
    const keywordMatches = this.keywordSearch(keywords, mode, limit);

    // Optional: semantic search if enabled (requires transformers)
    let semanticMatches: RAGMatch[] = [];
    if (this.enableSemanticSearch) {
      try {
        semanticMatches = await this.semanticSearch(input.query, mode, limit);
      } catch {
        // Fall back to keyword-only if semantic fails
      }
    }

    // Merge and deduplicate results
    const allMatches = this.mergeResults(keywordMatches, semanticMatches, limit);

    const executionTimeMs = Date.now() - startTime;

    return {
      query: input.query,
      mode,
      matches: allMatches,
      totalMatches: allMatches.length,
      executionTimeMs
    };
  }

  /**
   * Keyword-based search (BM25-inspired)
   */
  private keywordSearch(keywords: string[], mode: RAGMode, limit: number): RAGMatch[] {
    const results: Array<RAGMatch & { score: number }> = [];

    for (const [filePath, indexed] of this.fileIndex.entries()) {
      const lines = indexed.lines;
      
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        let matchScore = 0;

        // Calculate match score based on keywords
        for (const keyword of keywords) {
          const regex = new RegExp(`\\b${this.escapeRegex(keyword)}\\b`, "gi");
          const matches = line.match(regex) || [];
          matchScore += matches.length * 2; // Boost exact word boundaries
        }

        // Check for any keyword presence
        if (matchScore === 0) {
          for (const keyword of keywords) {
            if (line.toLowerCase().includes(keyword.toLowerCase())) {
              matchScore += 0.5;
            }
          }
        }

        if (matchScore > 0) {
          results.push({
            path: filePath,
            lineStart: lineIdx + 1,
            lineEnd: lineIdx + 1,
            preview: line.trim().slice(0, 200),
            confidence: Math.min(matchScore / keywords.length, 1.0),
            matchType: "text",
            score: matchScore
          });
        }
      }
    }

    // Sort by score and return top results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ score, ...rest }) => rest);
  }

  /**
   * Semantic search (optional, requires @xenova/transformers)
   */
  private async semanticSearch(query: string, mode: RAGMode, limit: number): Promise<RAGMatch[]> {
    // This is a stub - would require transformers library
    // For now, return empty array to maintain compatibility
    return [];
  }

  /**
   * Extract keywords from natural language query
   */
  private extractKeywords(query: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
      "of", "with", "is", "are", "was", "were", "be", "have", "has", "do",
      "does", "did", "will", "would", "should", "could", "how", "what",
      "when", "where", "why", "which", "this", "that", "these", "those"
    ]);

    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(word => {
        const clean = word.replace(/[^\w-]/g, "");
        return clean.length > 2 && !stopWords.has(clean);
      })
      .slice(0, 10);
  }

  /**
   * Ensure workspace is indexed
   */
  private async ensureIndexed(): Promise<void> {
    if (this.fileIndex.size > 0) return;

    const files = await this.collectFiles(this.workspaceRoot);
    
    for (const filePath of files.slice(0, 1000)) { // Limit to first 1000 files for speed
      try {
        const content = await fs.readFile(filePath, "utf8");
        const relativePath = path.relative(this.workspaceRoot, filePath).split(path.sep).join("/");
        
        this.fileIndex.set(relativePath, {
          path: relativePath,
          content,
          contentHash: this.hashContent(content),
          lines: content.split("\n")
        });
      } catch {
        // Skip files that can't be read
      }
    }
  }

  /**
   * Collect all indexable files
   */
  private async collectFiles(dir: string): Promise<string[]> {
    const skipDirs = new Set([".git", "node_modules", ".next", "dist", ".mesh", "build", "coverage"]);
    const skipExtensions = new Set([".png", ".jpg", ".gif", ".zip", ".pdf", ".wasm", ".dylib", ".so", ".dll"]);
    const results: string[] = [];

    const walk = async (current: string) => {
      try {
        const entries = await fs.readdir(current, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(current, entry.name);
          
          if (entry.isDirectory()) {
            if (!skipDirs.has(entry.name)) {
              await walk(fullPath);
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (!skipExtensions.has(ext)) {
              results.push(fullPath);
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    await walk(dir);
    return results;
  }

  /**
   * Merge keyword and semantic results
   */
  private mergeResults(keywordMatches: RAGMatch[], semanticMatches: RAGMatch[], limit: number): RAGMatch[] {
    const seen = new Set<string>();
    const merged: RAGMatch[] = [];

    for (const match of keywordMatches) {
      const key = `${match.path}:${match.lineStart}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(match);
      }
    }

    for (const match of semanticMatches) {
      const key = `${match.path}:${match.lineStart}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(match);
      }
    }

    return merged.slice(0, limit);
  }

  private hashContent(content: string): string {
    // Simple hash for content change detection
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
