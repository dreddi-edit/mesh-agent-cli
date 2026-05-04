/**
 * Shared Timeline Manager - Wave 1 Feature
 * Git worktree-based isolated execution for safe testing
 *
 * Used by: CLI, IDE (REST API), MCP (tools)
 */
import path from "node:path";
import { promises as fs, existsSync } from "node:fs";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
export class TimelineManager {
    workspaceRoot;
    timelinesDir;
    gitExecutable;
    timelines = new Map();
    constructor(options) {
        this.workspaceRoot = options.workspaceRoot;
        this.timelinesDir = options.timelinesDir ?? path.join(this.workspaceRoot, ".mesh", "timelines");
        this.gitExecutable = options.gitExecutable ?? "git";
    }
    /**
     * Create a new timeline (isolated git worktree)
     */
    async createTimeline(input) {
        const id = crypto.randomBytes(6).toString("hex");
        const baseBranch = input.baseBranch ?? "main";
        const workTreePath = path.join(this.timelinesDir, id);
        // Ensure timelines directory exists
        await fs.mkdir(this.timelinesDir, { recursive: true });
        // Verify base branch exists
        try {
            await this.runGit(["rev-parse", baseBranch]);
        }
        catch {
            throw new Error(`Base branch '${baseBranch}' does not exist`);
        }
        // Create worktree
        try {
            await this.runGit(["worktree", "add", workTreePath, baseBranch]);
        }
        catch (error) {
            throw new Error(`Failed to create worktree: ${error}`);
        }
        const metadata = {
            id,
            name: input.name,
            baseBranch,
            createdAt: new Date(),
            workTreePath,
            status: "active",
            description: input.description
        };
        this.timelines.set(id, metadata);
        await this.saveMetadata(id, metadata);
        return this.metadataToInfo(metadata);
    }
    /**
     * Apply patches to a timeline
     */
    async applyPatches(input) {
        const metadata = this.timelines.get(input.timelineId);
        if (!metadata) {
            throw new Error(`Timeline ${input.timelineId} not found`);
        }
        if (metadata.status !== "active") {
            throw new Error(`Timeline is ${metadata.status}, cannot apply patches`);
        }
        for (const patch of input.patches) {
            const fullPath = path.join(metadata.workTreePath, patch.path);
            const dir = path.dirname(fullPath);
            try {
                await fs.mkdir(dir, { recursive: true });
                if (patch.operation === "delete") {
                    await fs.rm(fullPath, { force: true });
                }
                else if (patch.operation === "create" || patch.operation === "update") {
                    await fs.writeFile(fullPath, patch.content ?? "", "utf8");
                }
            }
            catch (error) {
                throw new Error(`Failed to apply patch to ${patch.path}: ${error}`);
            }
        }
    }
    /**
     * Run a command in a timeline
     */
    async runInTimeline(input) {
        const metadata = this.timelines.get(input.timelineId);
        if (!metadata) {
            throw new Error(`Timeline ${input.timelineId} not found`);
        }
        const cwd = input.cwd ? path.join(metadata.workTreePath, input.cwd) : metadata.workTreePath;
        const timeout = input.timeout ?? 30000;
        const startTime = Date.now();
        try {
            const { stdout, stderr } = await execAsync(input.command, {
                cwd,
                timeout,
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer
            });
            return {
                timelineId: input.timelineId,
                command: input.command,
                exitCode: 0,
                stdout: stdout || "",
                stderr: stderr || "",
                durationMs: Date.now() - startTime
            };
        }
        catch (error) {
            return {
                timelineId: input.timelineId,
                command: input.command,
                exitCode: error.code ?? 1,
                stdout: error.stdout ?? "",
                stderr: error.stderr ?? error.message ?? "",
                durationMs: Date.now() - startTime
            };
        }
    }
    /**
     * Compare timeline against base branch
     */
    async compareTimeline(timelineId) {
        const metadata = this.timelines.get(timelineId);
        if (!metadata) {
            throw new Error(`Timeline ${timelineId} not found`);
        }
        try {
            // Get diff summary
            const { stdout: diffStat } = await execAsync(`cd "${metadata.workTreePath}" && git diff --stat ${metadata.baseBranch}`, { maxBuffer: 10 * 1024 * 1024 });
            // Parse diff stats
            const lines = diffStat.trim().split("\n");
            let filesChanged = 0;
            let insertions = 0;
            let deletions = 0;
            for (const line of lines) {
                const match = line.match(/(\d+)\s+insertion|(\d+)\s+deletion/g);
                if (match) {
                    for (const m of match) {
                        if (m.includes("insertion")) {
                            insertions += parseInt(m);
                        }
                        else if (m.includes("deletion")) {
                            deletions += parseInt(m);
                        }
                    }
                }
            }
            // Get file changes
            const { stdout: diffNames } = await execAsync(`cd "${metadata.workTreePath}" && git diff --name-status ${metadata.baseBranch}`, { maxBuffer: 10 * 1024 * 1024 });
            const fileChanges = diffNames
                .trim()
                .split("\n")
                .filter(line => line.length > 0)
                .map(line => {
                const [status, filePath] = line.split("\t");
                return {
                    path: filePath,
                    status: (status === "A" ? "added" : status === "D" ? "deleted" : "modified"),
                    additions: 0, // Would need more parsing for per-file stats
                    deletions: 0
                };
            });
            filesChanged = fileChanges.length;
            return {
                timelineId,
                baseBranch: metadata.baseBranch,
                diffSummary: {
                    filesChanged,
                    insertions,
                    deletions
                },
                fileChanges
            };
        }
        catch (error) {
            throw new Error(`Failed to compare timeline: ${error}`);
        }
    }
    /**
     * Promote timeline changes back to base branch
     */
    async promoteTimeline(timelineId) {
        const metadata = this.timelines.get(timelineId);
        if (!metadata) {
            throw new Error(`Timeline ${timelineId} not found`);
        }
        try {
            // Commit changes in worktree
            await execAsync(`cd "${metadata.workTreePath}" && git add -A && git commit -m "Promoted from timeline ${timelineId}"`);
            // Merge back to base branch
            const currentBranch = (await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: this.workspaceRoot })).stdout.trim();
            await this.runGit(["checkout", metadata.baseBranch]);
            // Create temporary worktree branch name
            const branchName = `timeline-${timelineId}`;
            const worktreeHead = (await execAsync("git rev-parse HEAD", { cwd: metadata.workTreePath })).stdout.trim();
            await this.runGit(["merge", worktreeHead, "-m", `Merge timeline ${timelineId}`]);
            await this.runGit(["checkout", currentBranch]);
            metadata.status = "merged";
            await this.saveMetadata(timelineId, metadata);
        }
        catch (error) {
            throw new Error(`Failed to promote timeline: ${error}`);
        }
    }
    /**
     * Clean up a timeline
     */
    async abandonTimeline(timelineId) {
        const metadata = this.timelines.get(timelineId);
        if (!metadata) {
            throw new Error(`Timeline ${timelineId} not found`);
        }
        try {
            await this.runGit(["worktree", "remove", metadata.workTreePath, "--force"]);
            metadata.status = "abandoned";
            await this.saveMetadata(timelineId, metadata);
        }
        catch (error) {
            throw new Error(`Failed to abandon timeline: ${error}`);
        }
    }
    /**
     * List all active timelines
     */
    async listTimelines() {
        await this.loadMetadata();
        return Array.from(this.timelines.values())
            .filter(m => m.status === "active")
            .map(m => this.metadataToInfo(m));
    }
    // Helpers
    async runGit(args) {
        return execFileAsync(this.gitExecutable, args, {
            cwd: this.workspaceRoot,
            maxBuffer: 10 * 1024 * 1024
        });
    }
    async saveMetadata(id, metadata) {
        const metaFile = path.join(this.timelinesDir, `${id}.json`);
        await fs.writeFile(metaFile, JSON.stringify(metadata, null, 2), "utf8");
    }
    async loadMetadata() {
        if (!existsSync(this.timelinesDir))
            return;
        const files = await fs.readdir(this.timelinesDir);
        for (const file of files) {
            if (file.endsWith(".json")) {
                try {
                    const content = await fs.readFile(path.join(this.timelinesDir, file), "utf8");
                    const metadata = JSON.parse(content);
                    metadata.createdAt = new Date(metadata.createdAt);
                    this.timelines.set(metadata.id, metadata);
                }
                catch {
                    // Skip invalid metadata files
                }
            }
        }
    }
    metadataToInfo(metadata) {
        return {
            id: metadata.id,
            name: metadata.name,
            baseBranch: metadata.baseBranch,
            createdAt: metadata.createdAt,
            workTreePath: metadata.workTreePath,
            status: metadata.status
        };
    }
}
