import { promises as fs } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { appendJsonl, readJson, writeJson } from "./common.js";

const execAsync = promisify(exec);

export interface ResurrectionSnapshot {
  sessionId: string;
  capturedAt: string;
  intent: string;
  filesInFocus: string[];
  openQuestions: string[];
  failedApproaches: Array<{ approach: string; reason: string }>;
  insights: string[];
  nextActions: string[];
  note: string;
  gitSummary: string;
  checkpoints: Array<{ at: string; note: string }>;
}

export class SessionResurrectionEngine {
  private readonly latestPath: string;
  private readonly logPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.latestPath = path.join(workspaceRoot, ".mesh", "session-resurrection", "latest.json");
    this.logPath = path.join(workspaceRoot, ".mesh", "session-resurrection", "sessions.jsonl");
  }

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "resurrect").trim().toLowerCase();
    switch (action) {
      case "capture":    return this.capture(args);
      case "resurrect":  return this.resurrect();
      case "checkpoint": return this.checkpoint(args);
      case "clear":      return this.clear();
      case "status":     return this.status();
      default:
        throw new Error("workspace.session_resurrection action must be capture|resurrect|checkpoint|status|clear");
    }
  }

  private async capture(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const intent = String(args.intent ?? "").trim();
    if (!intent) throw new Error("capture requires intent");

    const existing = await readJson<ResurrectionSnapshot | null>(this.latestPath, null);
    const sessionId = existing?.sessionId ?? crypto.randomBytes(6).toString("hex");
    const gitSummary = await this.gitSummary();

    const snapshot: ResurrectionSnapshot = {
      sessionId,
      capturedAt: new Date().toISOString(),
      intent,
      filesInFocus:      toStringArray(args.filesInFocus),
      openQuestions:     toStringArray(args.openQuestions),
      failedApproaches:  toFailedApproaches(args.failedApproaches),
      insights:          toStringArray(args.insights),
      nextActions:       toStringArray(args.nextActions),
      note:              String(args.note ?? "").trim(),
      gitSummary,
      checkpoints:       existing?.checkpoints ?? []
    };

    await writeJson(this.latestPath, snapshot);
    await appendJsonl(this.logPath, {
      sessionId: snapshot.sessionId,
      capturedAt: snapshot.capturedAt,
      intent: snapshot.intent,
      checkpointCount: snapshot.checkpoints.length
    });

    return {
      ok: true,
      action: "capture",
      sessionId: snapshot.sessionId,
      capturedAt: snapshot.capturedAt,
      path: ".mesh/session-resurrection/latest.json",
      message: "Session state captured. Run action=resurrect in any future session to restore full context."
    };
  }

  private async resurrect(): Promise<Record<string, unknown>> {
    const snapshot = await readJson<ResurrectionSnapshot | null>(this.latestPath, null);
    if (!snapshot) {
      return {
        ok: true,
        action: "resurrect",
        exists: false,
        message: "No previous session found. Work on something and use action=capture to save your state."
      };
    }

    const ageMs = Date.now() - new Date(snapshot.capturedAt).getTime();
    const brief = buildBrief(snapshot, formatAge(ageMs));

    return {
      ok: true,
      action: "resurrect",
      sessionId: snapshot.sessionId,
      capturedAt: snapshot.capturedAt,
      age: formatAge(ageMs),
      brief,
      snapshot,
      path: ".mesh/session-resurrection/latest.json"
    };
  }

  private async checkpoint(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const note = String(args.note ?? "").trim();
    if (!note) throw new Error("checkpoint requires note");

    const existing = await readJson<ResurrectionSnapshot | null>(this.latestPath, null);
    if (!existing) {
      return { ok: false, reason: "No active session. Run action=capture first." };
    }

    const checkpoints = [...existing.checkpoints, { at: new Date().toISOString(), note }].slice(-20);
    await writeJson(this.latestPath, { ...existing, checkpoints });

    return { ok: true, action: "checkpoint", note, totalCheckpoints: checkpoints.length };
  }

  private async clear(): Promise<Record<string, unknown>> {
    await fs.unlink(this.latestPath).catch(() => {});
    return { ok: true, action: "clear", message: "Session resurrection state cleared." };
  }

  private async status(): Promise<Record<string, unknown>> {
    const snapshot = await readJson<ResurrectionSnapshot | null>(this.latestPath, null);
    if (!snapshot) {
      return { ok: true, action: "status", exists: false, message: "No captured session." };
    }
    const ageMs = Date.now() - new Date(snapshot.capturedAt).getTime();
    return {
      ok: true,
      action: "status",
      exists: true,
      sessionId: snapshot.sessionId,
      capturedAt: snapshot.capturedAt,
      age: formatAge(ageMs),
      intent: snapshot.intent,
      openQuestionsCount: snapshot.openQuestions.length,
      nextActionsCount: snapshot.nextActions.length,
      checkpointsCount: snapshot.checkpoints.length,
      path: ".mesh/session-resurrection/latest.json"
    };
  }

  private async gitSummary(): Promise<string> {
    try {
      const { stdout } = await execAsync("git status --short", { cwd: this.workspaceRoot });
      const lines = stdout.trim().split("\n").filter(Boolean).slice(0, 8);
      return lines.length > 0 ? lines.join(", ") : "clean";
    } catch {
      return "unknown";
    }
  }
}

function buildBrief(s: ResurrectionSnapshot, age: string): string {
  const lines: string[] = [
    `╔══ SESSION RESURRECTION ═══════════════════════════════`,
    `║  Captured ${age} ago  [${s.sessionId}]`,
    `║`,
    `║  INTENT: ${s.intent}`,
  ];

  if (s.filesInFocus.length > 0) {
    lines.push(`║`, `║  FILES IN FOCUS:`);
    for (const f of s.filesInFocus) lines.push(`║    • ${f}`);
  }

  if (s.openQuestions.length > 0) {
    lines.push(`║`, `║  OPEN QUESTIONS (still unresolved):`);
    for (const q of s.openQuestions) lines.push(`║    ? ${q}`);
  }

  if (s.failedApproaches.length > 0) {
    lines.push(`║`, `║  FAILED APPROACHES (do not retry):`);
    for (const a of s.failedApproaches) {
      lines.push(`║    ✗ ${a.approach}${a.reason ? ` — ${a.reason}` : ""}`);
    }
  }

  if (s.insights.length > 0) {
    lines.push(`║`, `║  INSIGHTS DISCOVERED:`);
    for (const i of s.insights) lines.push(`║    ★ ${i}`);
  }

  if (s.nextActions.length > 0) {
    lines.push(`║`, `║  NEXT ACTIONS (pick the highest-leverage one):`);
    s.nextActions.forEach((a, idx) => lines.push(`║    ${idx + 1}. ${a}`));
  }

  if (s.checkpoints.length > 0) {
    const last = s.checkpoints[s.checkpoints.length - 1];
    lines.push(`║`, `║  LAST CHECKPOINT: ${last.note}`);
    lines.push(`║    at ${last.at}`);
  }

  if (s.note) {
    lines.push(`║`, `║  NOTE: ${s.note}`);
  }

  if (s.gitSummary && s.gitSummary !== "clean" && s.gitSummary !== "unknown") {
    lines.push(`║`, `║  GIT STATE AT CAPTURE: ${s.gitSummary}`);
  }

  lines.push(`╚════════════════════════════════════════════════════`);
  return lines.join("\n");
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function toFailedApproaches(value: unknown): Array<{ approach: string; reason: string }> {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (item && typeof item === "object") {
        return {
          approach: String((item as Record<string, unknown>).approach ?? ""),
          reason: String((item as Record<string, unknown>).reason ?? "")
        };
      }
      return { approach: String(item), reason: "" };
    }).filter(item => item.approach);
  }
  return [];
}
