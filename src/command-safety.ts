export interface CommandSafetyResult {
  ok: boolean;
  reason?: string;
  pattern?: string;
  parsed?: ParsedCommand;
}

export interface ParsedCommand {
  command: "npm" | "node" | "git";
  args: string[];
}

const ALLOWED_COMMANDS = new Set(["npm", "node", "git"]);

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
    pattern: /\b(?:cat|less|more|head|tail|sed|awk|grep|rg)\b[\s\S]*(?:^|\s)(?:\.env(?:\b|[./_-])|[^;&|]*\/\.env(?:\b|[./_-])|[^;&|]*(?:secret|credential|token|private)[^;&|]*\.(?:json|key|pem)\b)/i,
    reason: "credential file read"
  },
  {
    pattern: /(?:^|[;&|]\s*)(?:env|printenv|set)\b/i,
    reason: "environment dump"
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
  if (!normalized) return { ok: false, reason: "empty command" };
  
  // Strip quotes and backslashes to catch string splitting obfuscation (e.g. c"a"t)
  const deobfuscated = normalized.replace(/['"\\]/g, "");

  for (const entry of DESTRUCTIVE_PATTERNS) {
    if (entry.pattern.test(normalized) || entry.pattern.test(deobfuscated)) {
      return {
        ok: false,
        reason: entry.reason,
        pattern: String(entry.pattern)
      };
    }
  }

  // Block common shell obfuscation / dynamic execution techniques
  if (/(?:^|\|\s*|\&\&\s*|;\s*)(?:eval|exec)\s+/i.test(normalized)) {
    return { ok: false, reason: "dynamic evaluation (eval/exec) blocked" };
  }
  if (/(?:`[^`]*`|\$\([^)]*\))/.test(normalized)) {
    return { ok: false, reason: "command substitution blocked" };
  }
  if (/\|\s*base64\s+(?:-d|--decode)\s*\|\s*(?:sh|bash|zsh)/i.test(normalized)) {
    return { ok: false, reason: "base64 payload execution blocked" };
  }
  if (/\b(?:sh|bash|zsh)\s+-c\b/i.test(normalized)) {
    return { ok: false, reason: "nested shell execution blocked" };
  }
  if (/(?:^|[;&|]\s*)(?:curl|wget|nc|netcat)\b/i.test(normalized) && /\b(?:\.env|SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY|printenv|env)\b/i.test(normalized)) {
    return { ok: false, reason: "network credential exfiltration blocked" };
  }

  const parsed = tokenizeAllowedCommand(normalized);
  if ("reason" in parsed) return { ok: false, reason: parsed.reason };

  return { ok: true, parsed };
}

export function assertCommandAllowed(command: string): void {
  const safety = analyzeCommandSafety(command);
  if (!safety.ok) {
    throw new Error(`workspace.run_command blocked: ${safety.reason}`);
  }
}

export function parseAllowedCommand(command: string): ParsedCommand {
  const safety = analyzeCommandSafety(command);
  if (!safety.ok || !safety.parsed) {
    throw new Error(`workspace.run_command blocked: ${safety.reason}`);
  }
  return safety.parsed;
}

function tokenizeAllowedCommand(command: string): ParsedCommand | { reason: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && index + 1 < command.length) {
        index += 1;
        current += command[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (/[;&|<>]/.test(char)) {
      return { reason: "shell control operators are not allowed" };
    }
    if (char === "\\" || char === "`") {
      return { reason: "shell escaping and command substitution are not allowed" };
    }
    current += char;
  }

  if (quote) return { reason: "unterminated quoted argument" };
  if (current) tokens.push(current);
  if (tokens.length === 0) return { reason: "empty command" };

  const executable = tokens[0];
  if (!ALLOWED_COMMANDS.has(executable)) {
    return { reason: "command must start with an allowed executable: npm, node, or git" };
  }

  return {
    command: executable as ParsedCommand["command"],
    args: tokens.slice(1)
  };
}
