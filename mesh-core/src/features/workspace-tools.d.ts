/**
 * Basic Workspace Tools - Tier 1 essentials
 * File I/O, git basics, environment info
 */
import type { WorkspaceToolsConfig, FileInfo, GitStatus, GitDiff, DirectoryListing } from "./types.js";
export declare class WorkspaceTools {
    private config;
    constructor(config: WorkspaceToolsConfig);
    /**
     * List files in a directory
     */
    listFiles(dirPath: string, recursive?: boolean, maxDepth?: number): DirectoryListing;
    private walkDirectory;
    /**
     * Read file content
     */
    readFile(filePath: string, encoding?: BufferEncoding): string;
    /**
     * Write file content
     */
    writeFile(filePath: string, content: string, createDirs?: boolean): FileInfo;
    /**
     * Get file info/metadata
     */
    getFileInfo(filePath: string): FileInfo;
    /**
     * Get git status
     */
    gitStatus(): GitStatus;
    /**
     * Get git diff
     */
    gitDiff(base?: string, head?: string): GitDiff;
    /**
     * Run a command in workspace
     */
    runCommand(command: string, args?: string[], timeout?: number): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    /**
     * Get environment information
     */
    getEnvInfo(): Record<string, unknown>;
    /**
     * Delete a file or directory
     */
    deleteFile(filePath: string): void;
    /**
     * Copy file
     */
    copyFile(source: string, destination: string): FileInfo;
    private resolveWorkspacePath;
}
