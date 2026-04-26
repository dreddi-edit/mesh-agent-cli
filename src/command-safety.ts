export interface CommandSafetyResult {
  ok: boolean;
  reason?: string;
  pattern?: string;
}

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|--recursive\b[\s\S]*--force\b|--force\b[\s\S]*--recursive\b)/i,
    reason: "recursive forced deletion"
  },
  {
    pattern: /\b(?:sudo\s+)?(?:mkfs|diskutil\s+erase|fdisk|parted|sfdisk)\b/i,
    reason: "disk or filesystem mutation"
  },
  {
    pattern: /\bdd\b[\s\S]*\bof\s*=\s*(?:\/dev\/|\/)/i,
    reason: "raw disk or root filesystem write"
  },
  {
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
    reason: "fork bomb"
  },
  {
    pattern: /\bgit\s+push\b[\s\S]*(?:--force|-f\b)/i,
    reason: "forced git push"
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: "hard git reset"
  },
  {
    pattern: /\bgit\s+clean\b[\s\S]*-[^\s]*f/i,
    reason: "forced git clean"
  },
  {
    pattern: /\b(?:rm|shred|truncate)\b[\s\S]*(?:\.env(?:\b|[./_-])|_history\b|\.bash_history\b|\.zsh_history\b)/i,
    reason: "credential or shell history deletion"
  },
  {
    pattern: /\b(?:curl|wget|nc|netcat)\b[\s\S]*(?:\bprintenv\b|\benv\b|\bcat\s+\.env\b|\bcat\s+[^;&|]*\/\.env\b)/i,
    reason: "credential exfiltration pattern"
  },
  {
    pattern: /\bchmod\s+-R\s+777\s+(?:\/|\.)/i,
    reason: "unsafe recursive permission change"
  },
  {
    pattern: /\bchown\s+-R\b[\s\S]+\s(?:\/|\.)/i,
    reason: "unsafe recursive ownership change"
  }
];

export function analyzeCommandSafety(command: string): CommandSafetyResult {
  const normalized = command.trim();
  for (const entry of DESTRUCTIVE_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return {
        ok: false,
        reason: entry.reason,
        pattern: String(entry.pattern)
      };
    }
  }
  return { ok: true };
}

export function assertCommandAllowed(command: string): void {
  const safety = analyzeCommandSafety(command);
  if (!safety.ok) {
    throw new Error(`workspace.run_command blocked: ${safety.reason}`);
  }
}
