import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { TimelineManager } from "../timeline-manager.js";

const execAsync = promisify(execCb);

export interface SymptomBisectArgs {
  symptom: string;
  verificationCommand?: string;
  searchDepth?: number;
}

export class SymptomBisectEngine {
  constructor(
    private readonly workspaceRoot: string,
    private readonly timelines: TimelineManager
  ) {}

  async run(args: SymptomBisectArgs): Promise<Record<string, unknown>> {
    const symptom = args.symptom.trim();
    if (!symptom) throw new Error("workspace.symptom_bisect requires symptom");
    const verificationCommand = (args.verificationCommand || this.inferVerificationCommand(symptom)).trim();
    const depth = Math.max(10, Math.min(args.searchDepth ?? 50, 200));
    const commits = await this.readRecentCommits(depth);
    if (commits.length < 3) {
      return { ok: false, symptom, message: "Not enough commits to bisect." };
    }

    const newest = commits[0];
    const oldest = commits[commits.length - 1];
    const headCheck = await this.verifyCommit(newest, verificationCommand);
    const baseCheck = await this.verifyCommit(oldest, verificationCommand);

    if (headCheck.ok === baseCheck.ok) {
      return {
        ok: false,
        symptom,
        verificationCommand,
        message: "Verification signal is not divergent across search window; refine symptom or command.",
        newest,
        oldest
      };
    }

    const failingMeansRegression = headCheck.ok === false;
    let left = 0;
    let right = commits.length - 1;
    const probes: Array<Record<string, unknown>> = [];
    while (right - left > 1) {
      const mid = Math.floor((left + right) / 2);
      const commit = commits[mid];
      const probe = await this.verifyCommit(commit, verificationCommand);
      probes.push({ commit, ok: probe.ok, exitCode: probe.exitCode });
      const isFail = failingMeansRegression ? !probe.ok : probe.ok;
      if (isFail) {
        left = mid;
      } else {
        right = mid;
      }
    }

    const culprit = commits[left];
    return {
      ok: true,
      symptom,
      verificationCommand,
      culpritCommit: culprit,
      authorHint: await this.readAuthorForCommit(culprit),
      probes,
      message: `Regression likely introduced in ${culprit}.`
    };
  }

  private inferVerificationCommand(symptom: string): string {
    if (/redirect|login|button|page|ui|click/i.test(symptom)) {
      return "npm test";
    }
    if (/api|endpoint|request|response/i.test(symptom)) {
      return "npm test";
    }
    return "npm test";
  }

  private async readRecentCommits(depth: number): Promise<string[]> {
    const { stdout } = await execAsync(`git rev-list --max-count=${depth} HEAD`, {
      cwd: this.workspaceRoot
    });
    return stdout.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
  }

  private async readAuthorForCommit(commit: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`git show -s --format='%an <%ae>' ${commit}`, {
        cwd: this.workspaceRoot
      });
      return stdout.trim();
    } catch {
      return "unknown";
    }
  }

  private async verifyCommit(baseRef: string, verificationCommand: string): Promise<{ ok: boolean; exitCode: number }> {
    const timeline = await this.timelines.create({ name: `bisect-${baseRef.slice(0, 7)}`, baseRef });
    const run = await this.timelines.run({
      timelineId: timeline.timeline.id,
      command: verificationCommand,
      timeoutMs: 180_000
    });
    return { ok: run.ok, exitCode: run.exitCode };
  }
}
