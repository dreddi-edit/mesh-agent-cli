/**
 * Impact Analyzer - Wave 1 Feature
 * Analyzes the impact of changing specific symbols on the codebase
 *
 * Used by: CLI, IDE (REST API), MCP (tools)
 */
import type { ImpactAnalysisQuery, ImpactAnalysisResult } from "./types.js";
export interface ImpactAnalyzerOptions {
    workspaceRoot: string;
    maxDepth?: number;
}
export declare class ImpactAnalyzer {
    private workspaceRoot;
    private maxDepth;
    private symbolIndex;
    private usageIndex;
    private testFiles;
    constructor(options: ImpactAnalyzerOptions);
    /**
     * Analyze impact of changing symbols
     */
    analyze(query: ImpactAnalysisQuery): Promise<ImpactAnalysisResult>;
    /**
     * Find all usages of a symbol
     */
    private findUsages;
    /**
     * Ensure workspace is indexed
     */
    private ensureIndexed;
    /**
     * Collect all files in workspace
     */
    private collectFiles;
    private isTestFile;
    private calculateSeverity;
    private assessRiskLevel;
    private escapeRegex;
}
