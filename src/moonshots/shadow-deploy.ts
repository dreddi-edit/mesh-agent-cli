import { promises as fs } from "node:fs";
import path from "node:path";
import { TimelineManager } from "../timeline-manager.js";
import { assertCommandAllowed } from "../command-safety.js";
import { readJson, writeJson } from "./common.js";

export class ShadowDeployEngine {
  constructor(
    private readonly workspaceRoot: string,
    private readonly timelines: TimelineManager
  ) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "shadow").trim().toLowerCase();
    if (action === "status") return this.status();
    if (action !== "shadow") throw new Error("workspace.end_staging action must be shadow|status");

    const command = String(args.command ?? args.verificationCommand ?? "npm test").trim();
    assertCommandAllowed(command);
    const timeline = await this.timelines.create({ name: `shadow-deploy-${Date.now().toString(36)}` });
    const run = await this.timelines.run({
      timelineId: timeline.timeline.id,
      command,
      timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 180_000
    });
    const compare = await this.timelines.compare({ timelineIds: [timeline.timeline.id] });
    const telemetry = await readJson<{ signals?: Array<any> }>(path.join(this.workspaceRoot, ".mesh", "production-signals.json"), { signals: [] });
    const ledger = {
      ok: run.ok,
      action,
      timelineId: timeline.timeline.id,
      command,
      exitCode: run.exitCode,
      verdict: run.ok ? "ready_for_review" : "blocked",
      changedFiles: compare.comparisons[0]?.changedFiles ?? [],
      changedLineCount: compare.comparisons[0]?.changedLineCount ?? 0,
      telemetrySignalsChecked: telemetry.signals?.length ?? 0,
      gates: {
        verification: run.ok ? "pass" : "fail",
        telemetry: (telemetry.signals?.length ?? 0) > 0 ? "checked" : "no_signals",
        promotion: run.ok ? "manual_review_required" : "blocked"
      },
      stdout: run.stdout,
      stderr: run.stderr,
      ledgerPath: ".mesh/shadow-deploy/last-ledger.json"
    };
    await writeJson(path.join(this.workspaceRoot, ".mesh", "shadow-deploy", "last-ledger.json"), ledger);
    return ledger;
  }

  private async status(): Promise<Record<string, unknown>> {
    return readJson(path.join(this.workspaceRoot, ".mesh", "shadow-deploy", "last-ledger.json"), {
      ok: true,
      action: "status",
      message: "No shadow deploy ledger exists yet. Run action=shadow."
    });
  }
}
