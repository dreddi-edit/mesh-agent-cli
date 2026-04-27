# Technology Stack

**Project:** Mesh CLI -- Production-Readiness Sprint
**Researched:** 2026-04-27
**Focus:** Making an existing AI coding agent CLI reliable for investor demo

## Context

Mesh is already built. This is not a greenfield stack decision -- it is a production-hardening assessment of the existing stack with targeted recommendations for the specific gaps identified: LLM integration reliability, output formatting, artifact persistence, and error resilience.

The existing stack (TypeScript/Node.js, Bedrock Converse API via Cloudflare Worker proxy, ora/picocolors/marked-terminal for output) is sound. The issues are in *how* the stack is used, not *which* stack is used.

---

## Current Stack Assessment

### What Works (Do Not Touch)

| Technology | Version | Purpose | Assessment |
|------------|---------|---------|------------|
| TypeScript | 5.3.3 | All source code | Solid. Not worth upgrading during a fix sprint. |
| Node.js | Latest LTS | CLI runtime | Correct choice for CLI tooling. |
| picocolors | ^1.0.0 | Terminal colors | Zero-dep, fast. Better than chalk for this use case. |
| ora | ^7.0.1 | Spinners | Standard CLI spinner. Already well-integrated. |
| boxen | ^7.1.1 | Box drawing | Works for status displays. |
| enquirer | ^2.4.1 | Interactive prompts | Fine for setup flows. |
| dotenv | ^16.4.5 | Env loading | Standard. |

### What Needs Hardening (Fix How It Is Used)

| Technology | Issue | Recommendation |
|------------|-------|----------------|
| `llm-client.ts` (custom Bedrock client) | No retry with backoff, no timeout, swallows stream parse errors | Add exponential backoff, request timeout, structured error handling |
| `marked` + `marked-terminal` | Raw `marked.parse()` applied to LLM output can produce rendering artifacts | Sanitize LLM output before rendering; strip thought blocks |
| `.mesh/` file writes | Scattered `fs.writeFile` with inconsistent `mkdir` | Centralize artifact persistence with guaranteed directory creation |
| Worker proxy (`worker/src/index.ts`) | Only handles `/converse` path, no `/converse-stream` routing | Either add stream route to worker or document that streaming requires BYOK |
| Error surfaces | Raw `Error.message` shown to user via `pc.red()` | Classify errors into user-actionable categories |

---

## Recommended Stack Additions

### 1. LLM Integration Hardening

**Confidence: HIGH** (based on AWS Bedrock official docs + codebase analysis)

#### Exponential Backoff with Jitter

The current `llm-client.ts` tries fallback model IDs on failure but has **zero retry logic** for transient failures. This is the single biggest reliability gap.

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Custom retry wrapper (no new dep) | N/A | Exponential backoff for 429/503/408 | AWS Bedrock docs explicitly recommend retry for `ThrottlingException` (429), `ModelNotReadyException` (429), `ModelTimeoutException` (408), `ServiceUnavailableException` (503). The AWS SDK auto-retries up to 5 times, but Mesh uses raw `fetch()` through a proxy, so it gets none of this. |

**Implementation pattern:**

```typescript
// Add to llm-client.ts
private async fetchWithRetry(
  url: string, 
  init: RequestInit, 
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, init);
    
    if (response.ok || !this.isRetryable(response.status)) {
      return response;
    }
    
    if (attempt < maxRetries) {
      const baseDelay = Math.min(1000 * Math.pow(2, attempt), 8000);
      const jitter = Math.random() * baseDelay * 0.5;
      await new Promise(r => setTimeout(r, baseDelay + jitter));
    }
  }
  // Return last response for error extraction
  return fetch(url, init);
}

private isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}
```

**What NOT to do:** Do not add `p-retry` or `async-retry` as dependencies for this. The retry logic is ~15 lines. Adding a dependency for this increases install footprint for no reason.

#### Request Timeouts

The current code passes `AbortSignal` from the user-facing abort controller but has **no timeout** on individual LLM requests. A hung Bedrock request will hang the CLI forever.

```typescript
// Wrap the abort signal with a timeout
const timeoutMs = maxTokensOverride && maxTokensOverride > 4000 ? 120_000 : 60_000;
const timeout = AbortSignal.timeout(timeoutMs);
const combined = AbortSignal.any([abortSignal, timeout].filter(Boolean));
```

**Note:** `AbortSignal.any()` and `AbortSignal.timeout()` are available in Node.js 20+ (the current LTS target). No polyfill needed.

**Confidence: HIGH**

#### Prompt Caching Fix

The current code uses `cache_control: { type: "ephemeral" }` on system prompts and tool specs. This is the **Anthropic direct API format**, not the Bedrock Converse API format.

Per AWS Bedrock docs, the Converse API uses a different caching mechanism:

```json
// Bedrock Converse API format (correct)
{
  "system": [
    { "text": "system prompt" },
    { "cachePoint": { "type": "default" } }
  ],
  "toolConfig": {
    "tools": [
      { "toolSpec": { ... } },
      { "cachePoint": { "type": "default" } }
    ]
  }
}

// Anthropic direct API format (what Mesh currently uses -- wrong for Bedrock)
{
  "cache_control": { "type": "ephemeral" }
}
```

However, since Mesh routes through a Cloudflare Worker proxy that forwards to Bedrock, it depends on whether the proxy transforms the format. **Verify whether the `cache_control` fields are being silently ignored by Bedrock or causing errors.** If ignored, the fix is cosmetic. If causing validation errors, this is a critical fix.

**Minimum token threshold:** Bedrock requires 1,024 tokens per cache checkpoint for Claude models. The current code applies caching to system prompts > 1,000 characters, which may be under the token threshold (tokens != characters). Adjust the threshold to ~4,000 characters to be safe.

**Confidence: MEDIUM** (cache_control format mismatch identified but impact through proxy unclear)

#### Streaming Endpoint Gap

The worker proxy at `worker/src/index.ts` only matches the path `/model/{modelId}/converse`. The streaming client in `llm-client.ts` appends `/converse-stream` to the URL. This means **streaming through the shared proxy will always fail**, which explains the `streamingUnavailable` fallback flag in the agent loop.

Options:
1. **Quick fix (recommended for sprint):** Add `/converse-stream` route to the worker that proxies to Bedrock's ConverseStream endpoint. This is a ~10 line change.
2. **Alternative:** Accept that streaming only works in BYOK mode and ensure the non-streaming fallback is rock-solid.

**Confidence: HIGH** (verified by reading both `llm-client.ts` line 158 and `worker/src/index.ts` line 37)

---

### 2. Terminal Output Formatting

**Confidence: HIGH** (based on codebase analysis of `renderAssistantTurn` and `marked-terminal` usage)

#### marked + marked-terminal (Keep, Fix Usage)

| Technology | Version | Purpose | Why Keep |
|------------|---------|---------|----------|
| marked | ^11.0.1 | Markdown parser | Already integrated. Works. |
| marked-terminal | ^6.2.0 | Terminal markdown renderer | Standard for CLI markdown. |

**Current problem:** `marked.parse(text)` is called directly on raw LLM output. Claude sometimes emits `<thought>` blocks, partial markdown, or formatting artifacts that confuse `marked-terminal`.

**Fix pattern:**

```typescript
private renderAssistantTurn(text: string): void {
  const cleaned = this.sanitizeLlmOutput(text);
  const rendered = marked.parse(cleaned) as string;
  if (this.useAnsi) {
    output.write("\n" + this.themeColor(pc.bold("assistant")) + pc.dim(" > ") + "\n" + rendered + "\n");
    return;
  }
  output.write(`\nassistant> ${cleaned}\n`);
}

private sanitizeLlmOutput(text: string): string {
  return text
    // Strip <thought> blocks (Claude CoT)
    .replace(/<thought>[\s\S]*?<\/thought>/g, "")
    // Strip orphaned XML-like tags the model sometimes emits
    .replace(/<\/?(?:thought|thinking|reflection|scratchpad)[^>]*>/g, "")
    // Normalize excessive newlines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
```

**What NOT to do:** Do not switch to `ink` (React-based CLI renderer). It is a full framework replacement that would require rewriting all output code. The existing ora + picocolors + marked-terminal stack is correct for this project.

#### Progress Feedback Pattern

The spinner integration is already good (ora with step counters). The gap is that **slash commands that call the LLM silently show no progress**. Each slash command handler should follow this pattern:

```typescript
const spinner = ora({ text: "Analyzing codebase...", color: "cyan" }).start();
try {
  // ... do work ...
  spinner.text = "Generating report...";
  // ... more work ...
  spinner.succeed("Analysis complete -- saved to .mesh/precrime-report.json");
} catch (e) {
  spinner.fail(`Analysis failed: ${classifyError(e).userMessage}`);
}
```

**Confidence: HIGH**

---

### 3. Artifact Persistence

**Confidence: HIGH** (based on codebase analysis of ~30 `fs.writeFile` call sites)

#### Centralized Artifact Writer (No New Dependency)

The codebase has scattered `fs.mkdir` + `fs.writeFile` calls with inconsistent patterns. Some forget `{ recursive: true }`, some don't handle write failures.

**Recommended utility:**

```typescript
// src/artifact-writer.ts
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeArtifact(
  workspaceRoot: string,
  relativePath: string,
  content: string | object,
  options?: { format?: "json" | "text" | "markdown" }
): Promise<string> {
  const fullPath = path.join(workspaceRoot, ".mesh", relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  
  const serialized = typeof content === "object" 
    ? JSON.stringify(content, null, 2) 
    : content;
  
  // Atomic write: write to temp, then rename
  const tmpPath = fullPath + ".tmp";
  await fs.writeFile(tmpPath, serialized, "utf8");
  await fs.rename(tmpPath, fullPath);
  
  return fullPath;
}
```

**Key improvement: Atomic writes.** The current pattern of direct `writeFile` can produce corrupt files if the process crashes mid-write. `write-to-temp + rename` is atomic on POSIX systems. This matters for `.mesh/` artifacts that the dashboard reads -- a half-written JSON file causes dashboard crashes.

**What NOT to do:** Do not add `write-file-atomic` or `proper-lockfile` as dependencies. The temp+rename pattern is 3 lines and sufficient for single-process CLI usage.

#### Artifact Manifest

Each slash command should register what it produced:

```typescript
// After writing an artifact
await writeArtifact(root, "precrime/report.json", report);
await appendToManifest(root, {
  command: "/precrime",
  artifact: "precrime/report.json",
  createdAt: new Date().toISOString(),
  summary: `${report.predictions.length} predictions across ${report.filesAnalyzed} files`
});
```

This enables the dashboard to discover artifacts without hardcoding paths.

**Confidence: HIGH**

---

### 4. Error Resilience Patterns

**Confidence: HIGH** (based on analysis of error handling patterns across agent-loop.ts)

#### Error Classification

The current error display is `pc.red(`Error: ${(err as Error).message}`)`. LLM errors, file system errors, network errors, and tool errors all look the same to the user.

**Recommended pattern:**

```typescript
interface ClassifiedError {
  category: "llm" | "network" | "filesystem" | "tool" | "auth" | "unknown";
  userMessage: string;       // What to show the user
  technicalDetail: string;   // What to log
  recoverable: boolean;      // Can we retry?
  suggestion?: string;       // What the user can do
}

function classifyError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err);
  
  if (msg.includes("rate_limited") || msg.includes("429")) {
    return {
      category: "llm",
      userMessage: "Rate limited by LLM provider",
      technicalDetail: msg,
      recoverable: true,
      suggestion: "Wait a moment and try again, or switch to a different model with /model"
    };
  }
  
  if (msg.includes("unauthorized") || msg.includes("401") || msg.includes("Invalid JWT")) {
    return {
      category: "auth",
      userMessage: "Authentication failed",
      technicalDetail: msg,
      recoverable: false,
      suggestion: "Run /setup to re-authenticate, or check your BEDROCK_API_KEY"
    };
  }
  
  if (msg.includes("ENOENT") || msg.includes("EACCES")) {
    return {
      category: "filesystem",
      userMessage: "File operation failed",
      technicalDetail: msg,
      recoverable: false,
      suggestion: "Check file permissions and that the workspace path exists"
    };
  }
  
  // ... more categories
  
  return {
    category: "unknown",
    userMessage: "An unexpected error occurred",
    technicalDetail: msg,
    recoverable: false
  };
}
```

**Display pattern:**

```typescript
} catch (err) {
  const classified = classifyError(err);
  const prefix = classified.recoverable ? pc.yellow("warning>") : pc.red("error>");
  output.write(`\n${prefix} ${classified.userMessage}\n`);
  if (classified.suggestion) {
    output.write(pc.dim(`  hint: ${classified.suggestion}\n`));
  }
  // Log full detail for debugging
  await logger.write("error", classified.category, { detail: classified.technicalDetail });
}
```

#### Graceful Degradation for Slash Commands

Every slash command should follow the same error contract. Currently, if a moonshot engine throws, it bubbles up as a raw error. Wrap each command handler:

```typescript
case "/precrime":
  await this.safeRunCommand("precrime", () => this.runPrecrime(args));
  return { wasHandled: true, shouldExit: false };

// ...

private async safeRunCommand(name: string, fn: () => Promise<void>): Promise<void> {
  const spinner = ora({ text: `Running /${name}...`, color: "cyan" }).start();
  try {
    await fn();
  } catch (err) {
    const classified = classifyError(err);
    spinner.fail(`/${name} failed: ${classified.userMessage}`);
    if (classified.suggestion) {
      output.write(pc.dim(`  hint: ${classified.suggestion}\n`));
    }
    await this.logger.write("error", `command.${name}`, { detail: classified.technicalDetail });
  }
}
```

**Confidence: HIGH**

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not Alternative |
|----------|-------------|-------------|---------------------|
| LLM Client | Keep custom `llm-client.ts` | `@aws-sdk/client-bedrock-runtime` | Adding the AWS SDK is a massive dependency tree (~50+ packages). The custom client is ~380 lines and works. Fix the retry/timeout gaps instead. |
| Terminal Output | Keep `marked` + `marked-terminal` + `picocolors` | `ink` (React CLI) | Would require rewriting all output code. Ink is for building complex interactive TUIs, not adding markdown rendering to a chat CLI. |
| Terminal Output | Keep `picocolors` | `chalk` | picocolors is already used, zero-dep, faster. No reason to switch. |
| Spinners | Keep `ora` | `cli-spinners` + custom | ora already integrates cli-spinners. No reason to go lower-level. |
| File Writing | Custom atomic write util | `write-file-atomic` npm package | 3 lines of code vs. a dependency. Single-process CLI does not need lock files. |
| Retry Logic | Custom 15-line implementation | `p-retry` or `async-retry` | Too simple to justify a dependency. Retry logic is specific to Bedrock status codes. |
| Streaming | Fix worker proxy to support `/converse-stream` | Switch to SSE library | The Bedrock stream format is newline-delimited JSON, not SSE. The current manual parsing in `converseStream()` is correct, just needs the worker route. |
| Error Handling | Error classification function | `@hapi/boom` or custom error classes | Classification function is simpler and sufficient. No need for a HTTP error framework in a CLI. |

---

## Critical Configuration

### Bedrock-Specific Settings to Verify

| Setting | Current | Recommended | Why |
|---------|---------|-------------|-----|
| `BEDROCK_MAX_TOKENS` | Default 3000 | Keep 3000 for normal chat, 8000 for slash commands | Slash commands that generate reports need more tokens. Currently some commands produce truncated output because 3000 tokens is not enough for a full analysis. |
| `AGENT_MAX_STEPS` | Default 8 | Keep 8 for normal chat, override to 15-20 for slash commands | Some slash commands need many tool calls. The `maxStepsForInput()` method already does this but verify the multiplier is adequate. |
| `BEDROCK_TEMPERATURE` | Default 0 | Keep 0 | Deterministic output is correct for a coding agent. Do not change. |
| Cross-region inference profile | `us.anthropic.claude-sonnet-4-6` | Keep as-is | The `us.` prefix is already a cross-region inference profile ID, which provides automatic multi-region routing for higher availability. |
| Worker `RATE_LIMIT_PER_MIN` | 30 | Increase to 60 for demo | During an investor demo, rapid slash commands can easily hit 30 req/min. |

### Model Fallback Chain

Current: `claude-sonnet-4-6` -> `claude-haiku-4.5`

This is correct. Sonnet for quality, Haiku as fast fallback. The `shouldTryFallback()` method correctly retries on 404 (model not found), 429 (rate limit), and 5xx (server errors).

**Confidence: HIGH**

---

## Installation

No new packages needed. All fixes are internal to existing code.

```bash
# Verify current dependencies are installed
npm install

# Build to verify no type errors
npm run typecheck
```

---

## Sources

| Source | What It Informed | Confidence |
|--------|-----------------|------------|
| AWS Bedrock Converse API docs (official) | Retry behavior, error codes, cache format | HIGH |
| AWS Bedrock Prompt Caching docs (official) | `cachePoint` vs `cache_control` format difference | HIGH |
| AWS Bedrock Inference Profiles docs (official) | Cross-region routing, `us.` prefix meaning | HIGH |
| Codebase analysis: `llm-client.ts` (384 lines) | Current retry gaps, streaming implementation | HIGH |
| Codebase analysis: `worker/src/index.ts` (175 lines) | Missing `/converse-stream` route | HIGH |
| Codebase analysis: `agent-loop.ts` (4760 lines) | Error handling patterns, output rendering, slash command handlers | HIGH |
| Codebase analysis: `context-artifacts.ts` | Existing artifact storage pattern | HIGH |
| Codebase analysis: `model-catalog.ts` | Current model selection and fallback chain | HIGH |
| Codebase analysis: `structured-logger.ts` | Existing logging infrastructure | HIGH |

---

## Summary for Roadmap

**The stack is correct. The usage patterns need hardening.** Five specific changes, in priority order:

1. **Add retry with exponential backoff to `llm-client.ts`** -- Biggest reliability win. ~15 lines of code. Prevents demo failures from transient 429/503 errors.

2. **Add request timeouts** -- Prevents hung CLI from dead Bedrock connections. ~5 lines using `AbortSignal.timeout()`.

3. **Sanitize LLM output before `marked.parse()`** -- Prevents `<thought>` blocks and XML artifacts from corrupting terminal display. ~10 lines.

4. **Add `/converse-stream` route to worker proxy** -- Enables streaming for all users, not just BYOK. ~10 lines in `worker/src/index.ts`.

5. **Wrap slash command handlers in `safeRunCommand()`** -- Prevents raw stack traces from reaching users. Consistent spinner + error display for every command. ~20 lines for the wrapper, then mechanical changes to the switch statement.

**Total estimated code change: ~100 lines of new utility code + mechanical integration across command handlers.**

---

*Stack research: 2026-04-27*
