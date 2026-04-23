import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { loadConfig, AppConfig } from "../src/config.js";
import {
  BedrockLlmClient,
  ConverseMessage,
  ContentBlock,
  ToolSpec,
  LlmResponse
} from "../src/llm-client.js";
import { LocalToolBackend } from "../src/local-tools.js";
import { buildLlmSafeMeshContext } from "../src/mesh-gateway.js";
import { ToolBackend, ToolDefinition } from "../src/tool-backend.js";

const require = createRequire(import.meta.url);
const compressionCore = require("../mesh-core/src/compression-core.cjs") as {
  estimateTextTokens: (value: string) => number;
};
const { estimateTextTokens } = compressionCore;

const DIRECT_SYSTEM_PROMPT =
  "You are a code search assistant. The user will give you workspace context and ask for a single exact value. Reply with ONLY the exact value if found, or NOTFOUND.";

const AGENT_SYSTEM_PROMPT = [
  "You are Mesh, a high-performance terminal AI coding agent.",
  "Use tools to gather ground truth instead of guessing.",
  "Prefer workspace.grep_capsules and workspace.read_file first.",
  "Use workspace.read_file_raw or workspace.grep_content when you need exact literals.",
  "For exact secret or constant lookup, start with workspace.grep_content using a non-empty query such as SESSION_SECRET.",
  "Tool arguments must always be valid JSON and must include all required fields. Never call a tool with empty input.",
  "The user wants one exact value. Reply ONLY with the exact value or NOTFOUND."
].join("\n");

const CAPSULE_FIRST_SYSTEM_PROMPT = [
  "You are Mesh, a high-performance terminal AI coding agent.",
  "Use tools to gather ground truth instead of guessing.",
  "You are in strict capsule-first mode.",
  "Follow this exact algorithm:",
  "1. Call workspace.grep_capsules with query SESSION_SECRET.",
  "2. If matches are returned, call workspace.read_file_raw on the most likely matching path.",
  "3. Extract the exact value assigned to SESSION_SECRET.",
  "4. If no match is returned, respond NOTFOUND.",
  "Do not call search_files, list_files, list_directory, or get_index_status unless the previous step failed and you have no candidate path.",
  "Raw-content grep is unavailable in this mode, so do not try to use it.",
  "Tool arguments must always be valid JSON and must include all required fields.",
  "The user wants one exact value. Reply ONLY with the exact value or NOTFOUND."
].join("\n");

const READ_ONLY_TOOLS = new Set([
  "workspace.list_files",
  "workspace.read_file",
  "workspace.read_file_raw",
  "workspace.search_files",
  "workspace.grep_content",
  "workspace.grep_capsules",
  "workspace.get_index_status",
  "workspace.read_multiple_files",
  "workspace.read_file_lines",
  "workspace.list_directory",
  "workspace.get_file_info",
  "workspace.git_status"
]);

const CAPSULE_FIRST_TOOLS = new Set([
  "workspace.read_file",
  "workspace.read_file_raw",
  "workspace.grep_capsules",
  "workspace.read_multiple_files"
]);

const DEFAULT_MODEL = "us.anthropic.claude-opus-4-6-v1";
const DEFAULT_DIRECT_BUDGET = 8_000;
const DEFAULT_MAX_STEPS = 10;
const DEFAULT_CASES = [
  { fileCount: 20, needleAt: 5 },
  { fileCount: 80, needleAt: 60 },
  { fileCount: 180, needleAt: 150 }
];

interface EvalCase {
  fileCount: number;
  needleAt: number;
}

interface WorkspaceFile {
  path: string;
  source: string;
}

interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

interface EvalResult {
  caseId: string;
  mode: "direct" | "mesh-cli" | "mesh-cli-capsule";
  modelId: string;
  totalFiles: number;
  needleAt: number;
  pass: boolean;
  response: string;
  error: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  directContextTokens?: number;
  directFilesIncluded?: number;
  needleInDirectContext?: boolean;
  toolCalls?: number;
  toolTrace?: ToolTrace[];
}

function sanitizeModelName(modelId: string): string {
  return modelId.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function parseArgValue(argv: string[], name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function createAppConfig(base: AppConfig, workspaceRoot: string, modelId: string): AppConfig {
  return {
    ...base,
    bedrock: {
      ...base.bedrock,
      modelId
    },
    agent: {
      ...base.agent,
      workspaceRoot,
      enableCloudCache: false,
      maxSteps: DEFAULT_MAX_STEPS
    },
    supabase: {}
  };
}

function buildNeedleValue(caseId: string): string {
  return `MESH_NIAH_SECRET_${caseId.replace(/[^a-z0-9]/gi, "").toUpperCase()}_9A2F7E1C`;
}

function buildNeedleFile(idx: number, needleValue: string): string {
  return [
    `"use strict";`,
    "",
    `const SESSION_SECRET = "${needleValue}";`,
    "const SESSION_TTL_MS = 86400000;",
    "",
    "export function createSession(userId) {",
    "  return require('crypto')",
    "    .createHmac('sha256', SESSION_SECRET)",
    "    .update(String(userId))",
    "    .digest('hex');",
    "}",
    "",
    "export function validateSession(token, userId) {",
    "  return createSession(userId) === token;",
    "}",
    "",
    `export const moduleId = "auth-${idx}";`
  ].join("\n");
}

function buildFillerFile(idx: number): string {
  const lines: string[] = [`"use strict";`, "", `export const moduleId = "module-${idx}";`, ""];
  for (let i = 0; i < 32; i += 1) {
    lines.push(`export function helper_${idx}_${i}(value) {`);
    lines.push(`  const factor = ${idx + i + 3};`);
    lines.push("  return String(value).trim().toLowerCase() + ':' + factor;");
    lines.push("}");
    lines.push("");
  }
  lines.push("export const metadata = {");
  lines.push(`  owner: "team-${idx % 7}",`);
  lines.push(`  region: "${idx % 2 === 0 ? "eu-central" : "us-east"}",`);
  lines.push(`  retries: ${2 + (idx % 4)}`);
  lines.push("};");
  return lines.join("\n");
}

function buildWorkspaceFiles(fileCount: number, needleAt: number, needleValue: string): WorkspaceFile[] {
  const files: WorkspaceFile[] = [];
  for (let i = 0; i < fileCount; i += 1) {
    files.push({
      path: `src/module-${String(i).padStart(3, "0")}.js`,
      source: i === needleAt ? buildNeedleFile(i, needleValue) : buildFillerFile(i)
    });
  }
  return files;
}

async function createWorkspace(caseId: string, files: WorkspaceFile[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `mesh-cli-niah-${caseId}-`));
  await fs.mkdir(path.join(root, ".mesh", "index"), { recursive: true });
  await fs.mkdir(path.join(root, ".mesh", "history"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".mesh", "instructions.md"),
    "# Benchmark Workspace\n\nSynthetic workspace for Mesh CLI NIAH benchmark.\n",
    "utf8"
  );

  for (const file of files) {
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.source, "utf8");
  }

  return root;
}

function buildDirectContext(files: WorkspaceFile[], tokenBudget: number): {
  context: string;
  tokens: number;
  filesIncluded: number;
} {
  let context = "";
  let tokens = 0;
  let filesIncluded = 0;

  for (const file of files) {
    const block = `// FILE: ${file.path}\n${file.source}\n\n`;
    const blockTokens = estimateTextTokens(block);
    if (tokens + blockTokens > tokenBudget) break;
    context += block;
    tokens += blockTokens;
    filesIncluded += 1;
  }

  return { context, tokens, filesIncluded };
}

function normalizeAnswer(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").replace(/^"+|"+$/g, "").trim();
}

function toWireTools(tools: ToolDefinition[]): Array<{ wireName: string; tool: ToolDefinition }> {
  const used = new Set<string>();
  return tools.map((tool) => {
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
    let wireName = base;
    let index = 2;
    while (used.has(wireName)) {
      wireName = `${base}_${index}`;
      index += 1;
    }
    used.add(wireName);
    return { wireName, tool };
  });
}

function toToolSpecs(wireTools: Array<{ wireName: string; tool: ToolDefinition }>): ToolSpec[] {
  return wireTools.map(({ wireName, tool }) => ({
    name: wireName,
    description: tool.description ?? "",
    inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} }
  }));
}

async function indexWorkspace(backend: LocalToolBackend): Promise<void> {
  for await (const _ of backend.indexEverything()) {
    // consume generator to warm all capsules
  }
}

async function runDirectEval(
  llm: BedrockLlmClient,
  modelId: string,
  files: WorkspaceFile[],
  needleValue: string,
  tokenBudget: number,
  caseId: string,
  dryRun: boolean
): Promise<EvalResult> {
  const context = buildDirectContext(files, tokenBudget);
  const needleInDirectContext = files
    .slice(0, context.filesIncluded)
    .some((file) => file.source.includes(needleValue));

  if (dryRun) {
    return {
      caseId,
      mode: "direct",
      modelId,
      totalFiles: files.length,
      needleAt: files.findIndex((file) => file.source.includes(needleValue)),
      pass: false,
      response: "DRY_RUN",
      error: null,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      directContextTokens: context.tokens,
      directFilesIncluded: context.filesIncluded,
      needleInDirectContext
    };
  }

  const userPrompt = [
    "WORKSPACE CONTEXT:",
    context.context,
    "",
    "QUESTION: Find the exact value of SESSION_SECRET in this workspace.",
    "Reply with only the value or NOTFOUND."
  ].join("\n");

  const startedAt = Date.now();
  try {
    const response = await llm.converse(
      [{ role: "user", content: [{ text: userPrompt }] }],
      [],
      DIRECT_SYSTEM_PROMPT,
      modelId
    );
    const latencyMs = Date.now() - startedAt;
    const answer = normalizeAnswer(response.kind === "text" ? response.text : response.text ?? "");
    const inputTokens = response.usage?.inputTokens ?? 0;
    const outputTokens = response.usage?.outputTokens ?? 0;
    return {
      caseId,
      mode: "direct",
      modelId,
      totalFiles: files.length,
      needleAt: files.findIndex((file) => file.source.includes(needleValue)),
      pass: answer === needleValue,
      response: answer,
      error: null,
      latencyMs,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      directContextTokens: context.tokens,
      directFilesIncluded: context.filesIncluded,
      needleInDirectContext
    };
  } catch (error) {
    return {
      caseId,
      mode: "direct",
      modelId,
      totalFiles: files.length,
      needleAt: files.findIndex((file) => file.source.includes(needleValue)),
      pass: false,
      response: "",
      error: (error as Error).message,
      latencyMs: Date.now() - startedAt,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      directContextTokens: context.tokens,
      directFilesIncluded: context.filesIncluded,
      needleInDirectContext
    };
  }
}

async function runMeshAgentEval(
  llm: BedrockLlmClient,
  backend: ToolBackend,
  modelId: string,
  needleValue: string,
  fileCount: number,
  needleAt: number,
  caseId: string,
  maxSteps: number,
  dryRun: boolean,
  mode: "mesh-cli" | "mesh-cli-capsule",
  allowedTools: Set<string>,
  systemPrompt: string
): Promise<EvalResult> {
  if (dryRun) {
    return {
      caseId,
      mode,
      modelId,
      totalFiles: fileCount,
      needleAt,
      pass: false,
      response: "DRY_RUN",
      error: null,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      toolTrace: []
    };
  }

  const tools = (await backend.listTools()).filter((tool) => allowedTools.has(tool.name));
  const wireTools = toWireTools(tools);
  const toolSpecs = toToolSpecs(wireTools);
  const wireToolMap = new Map(wireTools.map((item) => [item.wireName, item]));
  const transcript: ConverseMessage[] = [
    {
      role: "user",
      content: [
        {
          text: [
            "Find the exact value of SESSION_SECRET somewhere in this workspace.",
            "Use workspace tools as needed.",
            "Reply with only the exact value or NOTFOUND."
          ].join("\n")
        }
      ]
    }
  ];
  const toolTrace: ToolTrace[] = [];
  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0 };
  const startedAt = Date.now();
  let lastText = "";

  try {
    for (let step = 0; step < maxSteps; step += 1) {
      const response = await llm.converse(transcript, toolSpecs, AGENT_SYSTEM_PROMPT, modelId);
      usage.inputTokens += response.usage?.inputTokens ?? 0;
      usage.outputTokens += response.usage?.outputTokens ?? 0;

      if (response.kind === "text") {
        const answer = normalizeAnswer(response.text);
        return {
          caseId,
          mode,
          modelId,
          totalFiles: fileCount,
          needleAt,
          pass: answer === needleValue,
          response: answer,
          error: null,
          latencyMs: Date.now() - startedAt,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
          toolCalls: toolTrace.length,
          toolTrace
        };
      }

      lastText = (response.text ?? lastText).trim();
      const assistantContent: ContentBlock[] = [];
      if (response.text) {
        assistantContent.push({ text: response.text });
      }
      assistantContent.push({
        toolUse: {
          toolUseId: response.toolUseId,
          name: response.name,
          input: response.input
        }
      });
      transcript.push({ role: "assistant", content: assistantContent });

      const selectedTool = wireToolMap.get(response.name);
      if (!selectedTool) {
        transcript.push({
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: response.toolUseId,
                status: "error",
                content: [{ text: `Tool '${response.name}' is not available.` }]
              }
            }
          ]
        });
        toolTrace.push({ name: response.name, args: response.input, ok: false });
        continue;
      }

      try {
        const raw = await backend.callTool(selectedTool.tool.name, response.input);
        const resultText = await buildLlmSafeMeshContext(selectedTool.tool.name, response.input, raw);
        transcript.push({
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: response.toolUseId,
                status: "success",
                content: [{ text: resultText }]
              }
            }
          ]
        });
        toolTrace.push({ name: selectedTool.tool.name, args: response.input, ok: true });
      } catch (error) {
        transcript.push({
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: response.toolUseId,
                status: "error",
                content: [{ text: `Tool execution failed: ${(error as Error).message}` }]
              }
            }
          ]
        });
        toolTrace.push({ name: selectedTool.tool.name, args: response.input, ok: false });
      }
    }

    return {
      caseId,
      mode,
      modelId,
      totalFiles: fileCount,
      needleAt,
      pass: false,
      response: lastText || "STOPPED",
      error: `Stopped after ${maxSteps} steps without final answer.`,
      latencyMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      toolCalls: toolTrace.length,
      toolTrace
    };
  } catch (error) {
    return {
      caseId,
      mode,
      modelId,
      totalFiles: fileCount,
      needleAt,
      pass: false,
      response: lastText,
      error: (error as Error).message,
      latencyMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      toolCalls: toolTrace.length,
      toolTrace
    };
  }
}

function summarize(results: EvalResult[]): {
  directPassRate: number;
  meshPassRate: number;
  capsulePassRate: number;
  directAvgTokens: number;
  meshAvgTokens: number;
  capsuleAvgTokens: number;
  directAvgLatencyMs: number;
  meshAvgLatencyMs: number;
  capsuleAvgLatencyMs: number;
} {
  const direct = results.filter((result) => result.mode === "direct");
  const mesh = results.filter((result) => result.mode === "mesh-cli");
  const capsule = results.filter((result) => result.mode === "mesh-cli-capsule");
  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  return {
    directPassRate: avg(direct.map((result) => (result.pass ? 1 : 0))),
    meshPassRate: avg(mesh.map((result) => (result.pass ? 1 : 0))),
    capsulePassRate: avg(capsule.map((result) => (result.pass ? 1 : 0))),
    directAvgTokens: avg(direct.map((result) => result.totalTokens)),
    meshAvgTokens: avg(mesh.map((result) => result.totalTokens)),
    capsuleAvgTokens: avg(capsule.map((result) => result.totalTokens)),
    directAvgLatencyMs: avg(direct.map((result) => result.latencyMs)),
    meshAvgLatencyMs: avg(mesh.map((result) => result.latencyMs)),
    capsuleAvgLatencyMs: avg(capsule.map((result) => result.latencyMs))
  };
}

function renderReport(modelId: string, results: EvalResult[]): string {
  const summary = summarize(results);
  const lines = [
    `Mesh CLI NIAH Benchmark`,
    `Model: ${modelId}`,
    "",
    `${"case".padEnd(12)} ${"mode".padEnd(10)} ${"files".padStart(5)} ${"needle".padStart(6)} ${"pass".padStart(5)} ${"tokens".padStart(8)} ${"latency".padStart(8)} ${"details".padEnd(0)}`
  ];

  for (const result of results) {
    const details =
      result.mode === "direct"
        ? `included=${result.directFilesIncluded} inCtx=${result.needleInDirectContext} ctxTok=${result.directContextTokens}`
        : `tools=${result.toolCalls}`;
    lines.push(
      [
        result.caseId.padEnd(12),
        result.mode.padEnd(10),
        String(result.totalFiles).padStart(5),
        String(result.needleAt).padStart(6),
        String(result.pass).padStart(5),
        String(result.totalTokens).padStart(8),
        `${result.latencyMs}ms`.padStart(8),
        details
      ].join(" ")
    );
    if (result.error) {
      lines.push(`  error: ${result.error}`);
    } else {
      lines.push(`  response: ${result.response}`);
    }
    if (result.mode !== "direct" && result.toolTrace && result.toolTrace.length > 0) {
      lines.push(`  toolTrace: ${result.toolTrace.map((entry) => `${entry.name}${entry.ok ? "" : "!"}`).join(" -> ")}`);
    }
  }

  lines.push("");
  lines.push(`Summary: direct pass ${(summary.directPassRate * 100).toFixed(0)}%, mesh-cli pass ${(summary.meshPassRate * 100).toFixed(0)}%, capsule-first pass ${(summary.capsulePassRate * 100).toFixed(0)}%`);
  lines.push(`Summary: direct avg tokens ${summary.directAvgTokens.toFixed(0)}, mesh-cli avg tokens ${summary.meshAvgTokens.toFixed(0)}, capsule-first avg tokens ${summary.capsuleAvgTokens.toFixed(0)}`);
  lines.push(`Summary: direct avg latency ${summary.directAvgLatencyMs.toFixed(0)}ms, mesh-cli avg latency ${summary.meshAvgLatencyMs.toFixed(0)}ms, capsule-first avg latency ${summary.capsuleAvgLatencyMs.toFixed(0)}ms`);
  return lines.join("\n");
}

async function saveResults(modelId: string, results: EvalResult[], report: string): Promise<void> {
  const dir = path.join(process.cwd(), "benchmarks", "results");
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, "-");
  const base = `mesh-cli-niah-${sanitizeModelName(modelId)}-${stamp}`;
  await fs.writeFile(path.join(dir, `${base}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), modelId, results }, null, 2), "utf8");
  await fs.writeFile(path.join(dir, `${base}.md`), ["```", report, "```"].join("\n"), "utf8");
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const modelId = parseArgValue(argv, "--model") || DEFAULT_MODEL;
  const directBudget = Number(parseArgValue(argv, "--direct-budget") || DEFAULT_DIRECT_BUDGET);
  const maxSteps = Number(parseArgValue(argv, "--steps") || DEFAULT_MAX_STEPS);
  const save = argv.includes("--save");
  const dryRun = argv.includes("--dry-run");
  const casesArg = parseArgValue(argv, "--cases");
  const cases: EvalCase[] = casesArg
    ? casesArg.split(",").map((entry) => {
        const [fileCountRaw, needleAtRaw] = entry.split(":");
        return { fileCount: Number(fileCountRaw), needleAt: Number(needleAtRaw) };
      })
    : DEFAULT_CASES;

  const baseConfig = await loadConfig();
  if (!baseConfig.bedrock.endpointBase) {
    throw new Error("Missing Bedrock endpoint configuration.");
  }

  const llm = new BedrockLlmClient({
    endpointBase: baseConfig.bedrock.endpointBase,
    bearerToken: baseConfig.bedrock.bearerToken,
    modelId,
    temperature: 0,
    maxTokens: 80
  });

  const results: EvalResult[] = [];

  for (const testCase of cases) {
    const caseId = `${testCase.fileCount}f-${testCase.needleAt}n`;
    const needleValue = buildNeedleValue(caseId);
    const files = buildWorkspaceFiles(testCase.fileCount, testCase.needleAt, needleValue);
    const workspaceRoot = await createWorkspace(caseId, files);
    const config = createAppConfig(baseConfig, workspaceRoot, modelId);
    const backend = new LocalToolBackend(workspaceRoot, config);

    try {
      await indexWorkspace(backend);
      results.push(await runDirectEval(llm, modelId, files, needleValue, directBudget, caseId, dryRun));
      results.push(
        await runMeshAgentEval(
          llm,
          backend,
          modelId,
          needleValue,
          testCase.fileCount,
          testCase.needleAt,
          caseId,
          maxSteps,
          dryRun,
          "mesh-cli",
          READ_ONLY_TOOLS,
          AGENT_SYSTEM_PROMPT
        )
      );
      results.push(
        await runMeshAgentEval(
          llm,
          backend,
          modelId,
          needleValue,
          testCase.fileCount,
          testCase.needleAt,
          caseId,
          maxSteps,
          dryRun,
          "mesh-cli-capsule",
          CAPSULE_FIRST_TOOLS,
          CAPSULE_FIRST_SYSTEM_PROMPT
        )
      );
    } finally {
      await backend.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }

  const report = renderReport(modelId, results);
  process.stdout.write(`${report}\n`);

  if (save) {
    await saveResults(modelId, results, report);
  }
}

run().catch((error) => {
  process.stderr.write(`${(error as Error).stack || (error as Error).message}\n`);
  process.exitCode = 1;
});
