export interface CriticResult {
  ok: boolean;
  findings: Array<{ severity: "low" | "medium" | "high"; reason: string; evidence?: string }>;
}

export function runCritic(input: { diffPreview: string; verificationOk: boolean }): CriticResult {
  const findings: CriticResult["findings"] = [];
  if (!input.verificationOk) {
    findings.push({
      severity: "high",
      reason: "Verification failed but promotion attempted.",
      evidence: "timeline verification verdict != pass"
    });
  }
  if (/any\b/.test(input.diffPreview)) {
    findings.push({
      severity: "medium",
      reason: "Diff introduces implicit any-like typing risk.",
      evidence: "Detected token 'any' in diff preview"
    });
  }
  if (/TODO|FIXME/.test(input.diffPreview)) {
    findings.push({
      severity: "low",
      reason: "Diff includes TODO/FIXME markers.",
      evidence: "Detected TODO/FIXME in diff preview"
    });
  }
  return {
    ok: findings.every((finding) => finding.severity !== "high"),
    findings
  };
}
