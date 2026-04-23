import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig, AppConfig } from "../src/config.js";
import {
  BedrockLlmClient,
  ConverseMessage,
  ContentBlock,
  ToolSpec
} from "../src/llm-client.js";
import { LocalToolBackend } from "../src/local-tools.js";
import { buildLlmSafeMeshContext } from "../src/mesh-gateway.js";
import { ToolBackend, ToolDefinition } from "../src/tool-backend.js";

const DEFAULT_MODEL = "us.anthropic.claude-opus-4-6-v1";
const DEFAULT_MAX_STEPS = 12;
const DIRECT_MAX_CONTEXT_CHARS = 24000;

const DIRECT_SYSTEM_PROMPT = [
  "You are solving a small software bug in a local repository.",
  "You do not have tools in this mode. You must reason from the provided files only.",
  "Return JSON only.",
  "Schema:",
  '{ "summary": "short fix summary", "edits": [{ "path": "relative/path", "search": "exact old text", "replace": "exact new text" }] }',
  "Use the minimum necessary edits.",
  "If no fix is possible from the provided context, return an empty edits array."
].join("\n");

const MESH_SYSTEM_PROMPT = [
  "You are Mesh, a high-performance terminal AI coding agent.",
  "You are solving a small software bug in a local repository.",
  "Use tools to inspect the repo, edit the minimum necessary files, and verify the fix.",
  "Always run the relevant test command before finishing.",
  "Prefer workspace.read_file and workspace.read_file_raw to understand files before editing.",
  "Use workspace.patch_file for targeted edits.",
  "Use workspace.run_command to run tests.",
  "When the tests pass, answer with one short sentence describing the fix."
].join("\n");

const MESH_TOOLS = new Set([
  "workspace.list_files",
  "workspace.read_file",
  "workspace.read_file_raw",
  "workspace.search_files",
  "workspace.grep_content",
  "workspace.grep_capsules",
  "workspace.write_file",
  "workspace.patch_file",
  "workspace.run_command",
  "workspace.read_multiple_files",
  "workspace.read_file_lines",
  "workspace.list_directory",
  "workspace.get_file_info"
]);

interface BenchmarkCase {
  id: string;
  title: string;
  issue: string;
  verifyCommand: string;
  files: Array<{ path: string; content: string }>;
}

interface ToolTrace {
  name: string;
  ok: boolean;
}

interface DirectEdit {
  path: string;
  search: string;
  replace: string;
}

interface BenchmarkResult {
  caseId: string;
  mode: "direct" | "mesh";
  resolved: boolean;
  verifyPassed: boolean;
  summary: string;
  error: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  filesChanged: string[];
  toolCalls: number;
  toolTrace: ToolTrace[];
}

function parseArgValue(argv: string[], name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function sanitizeModelName(modelId: string): string {
  return modelId.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function createAppConfig(base: AppConfig, workspaceRoot: string, modelId: string, maxSteps: number): AppConfig {
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
      maxSteps
    },
    supabase: {}
  };
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

async function collectFixtureCases(): Promise<BenchmarkCase[]> {
  const suiteRoot = path.join(process.cwd(), "benchmarks", "swe-cases");
  const entries = await fs.readdir(suiteRoot, { withFileTypes: true });
  const cases: BenchmarkCase[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const caseRoot = path.join(suiteRoot, entry.name);
    const metadataPath = path.join(caseRoot, "case.json");
    const filesRoot = path.join(caseRoot, "files");
    if (!(await pathExists(metadataPath)) || !(await pathExists(filesRoot))) continue;

    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as Omit<BenchmarkCase, "files">;
    const files: Array<{ path: string; content: string }> = [];
    const queue = [filesRoot];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      const childEntries = await fs.readdir(current, { withFileTypes: true });
      for (const child of childEntries) {
        const childPath = path.join(current, child.name);
        if (child.isDirectory()) {
          queue.push(childPath);
          continue;
        }
        files.push({
          path: path.relative(filesRoot, childPath).split(path.sep).join("/"),
          content: await fs.readFile(childPath, "utf8")
        });
      }
    }

    cases.push({ ...metadata, files: files.sort((a, b) => a.path.localeCompare(b.path)) });
  }

  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

async function createWorkspace(testCase: BenchmarkCase): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `mesh-cli-swe-${testCase.id}-`));
  await fs.mkdir(path.join(root, ".mesh", "index"), { recursive: true });
  await fs.mkdir(path.join(root, ".mesh", "history"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".mesh", "instructions.md"),
    "# SWE Benchmark Workspace\n\nFix the described bug and verify with tests.\n",
    "utf8"
  );

  for (const file of testCase.files) {
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, "utf8");
  }

  return root;
}

function buildDirectContext(testCase: BenchmarkCase): string {
  const header = [
    `Issue: ${testCase.title}`,
    testCase.issue,
    `Verifier: ${testCase.verifyCommand}`,
    ""
  ].join("\n");

  let body = "";
  for (const file of testCase.files) {
    const block = `FILE: ${file.path}\n${file.content}\n\n`;
    if ((header.length + body.length + block.length) > DIRECT_MAX_CONTEXT_CHARS) break;
    body += block;
  }
  return `${header}${body}`;
}

function stripCodeFences(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  return trimmed;
}

function parseDirectPayload(raw: string): { summary: string; edits: DirectEdit[] } {
  const parsed = JSON.parse(stripCodeFences(raw)) as {
    summary?: string;
    edits?: Array<Partial<DirectEdit>>;
  };
  const edits = Array.isArray(parsed.edits)
    ? parsed.edits
        .filter((edit) => typeof edit.path === "string" && typeof edit.search === "string" && typeof edit.replace === "string")
        .map((edit) => ({
          path: String(edit.path),
          search: String(edit.search),
          replace: String(edit.replace)
        }))
    : [];
  return { summary: String(parsed.summary ?? "").trim(), edits };
}

async function requestDirectPayload(
  llm: BedrockLlmClient,
  prompt: string,
  modelId: string
): Promise<{
  payload: { summary: string; edits: DirectEdit[] };
  inputTokens: number;
  outputTokens: number;
}> {
  let inputTokens = 0;
  let outputTokens = 0;

  const first = await llm.converse(
    [{ role: "user", content: [{ text: prompt }] }],
    [],
    DIRECT_SYSTEM_PROMPT,
    modelId
  );
  inputTokens += first.usage?.inputTokens ?? 0;
  outputTokens += first.usage?.outputTokens ?? 0;
  const firstText = first.kind === "text" ? first.text : (first.text ?? "");

  try {
    return {
      payload: parseDirectPayload(firstText),
      inputTokens,
      outputTokens
    };
  } catch {
    const repairPrompt = [
      "Convert the following answer into valid JSON only.",
      "Keep the same intended summary and edits.",
      "Required schema:",
      '{ "summary": "short fix summary", "edits": [{ "path": "relative/path", "search": "exact old text", "replace": "exact new text" }] }',
      "",
      "Answer to convert:",
      firstText
    ].join("\n");
    const repair = await llm.converse(
      [{ role: "user", content: [{ text: repairPrompt }] }],
      [],
      DIRECT_SYSTEM_PROMPT,
      modelId
    );
    inputTokens += repair.usage?.inputTokens ?? 0;
    outputTokens += repair.usage?.outputTokens ?? 0;
    const repairText = repair.kind === "text" ? repair.text : (repair.text ?? "");
    return {
      payload: parseDirectPayload(repairText),
      inputTokens,
      outputTokens
    };
  }
}

async function applyDirectEdits(workspaceRoot: string, edits: DirectEdit[]): Promise<string[]> {
  const changed = new Set<string>();
  for (const edit of edits) {
    const target = path.join(workspaceRoot, edit.path);
    const content = await fs.readFile(target, "utf8");
    if (!content.includes(edit.search)) {
      throw new Error(`Direct edit search text not found in ${edit.path}`);
    }
    const next = content.replace(edit.search, edit.replace);
    await fs.writeFile(target, next, "utf8");
    changed.add(edit.path);
  }
  return Array.from(changed).sort();
}

async function compareChangedFiles(workspaceRoot: string, originalFiles: Array<{ path: string; content: string }>): Promise<string[]> {
  const changed: string[] = [];
  for (const file of originalFiles) {
    const current = await fs.readFile(path.join(workspaceRoot, file.path), "utf8");
    if (current !== file.content) changed.push(file.path);
  }
  return changed.sort();
}

async function indexWorkspace(backend: LocalToolBackend): Promise<void> {
  for await (const _ of backend.indexEverything()) {
    // warm capsules
  }
}

async function runVerifyCommand(backend: ToolBackend, command: string): Promise<{ ok: boolean; stderr?: string; stdout?: string }> {
  return await backend.callTool("workspace.run_command", { command }) as { ok: boolean; stderr?: string; stdout?: string };
}

async function runDirectCase(
  llm: BedrockLlmClient,
  backend: ToolBackend,
  workspaceRoot: string,
  testCase: BenchmarkCase,
  modelId: string,
  dryRun: boolean
): Promise<BenchmarkResult> {
  if (dryRun) {
    return {
      caseId: testCase.id,
      mode: "direct",
      resolved: false,
      verifyPassed: false,
      summary: "DRY_RUN",
      error: null,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      filesChanged: [],
      toolCalls: 0,
      toolTrace: []
    };
  }

  const startedAt = Date.now();
  try {
    const response = await requestDirectPayload(llm, buildDirectContext(testCase), modelId);
    const latencyMs = Date.now() - startedAt;
    const filesChanged = await applyDirectEdits(workspaceRoot, response.payload.edits);
    const verify = await runVerifyCommand(backend, testCase.verifyCommand);
    return {
      caseId: testCase.id,
      mode: "direct",
      resolved: Boolean(verify.ok),
      verifyPassed: Boolean(verify.ok),
      summary: response.payload.summary || "Applied direct edits.",
      error: verify.ok ? null : `Verifier failed: ${(verify.stderr || verify.stdout || "").slice(0, 400)}`,
      latencyMs,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      totalTokens: response.inputTokens + response.outputTokens,
      filesChanged,
      toolCalls: 0,
      toolTrace: []
    };
  } catch (error) {
    return {
      caseId: testCase.id,
      mode: "direct",
      resolved: false,
      verifyPassed: false,
      summary: "",
      error: (error as Error).message,
      latencyMs: Date.now() - startedAt,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      filesChanged: await compareChangedFiles(workspaceRoot, testCase.files),
      toolCalls: 0,
      toolTrace: []
    };
  }
}

async function runMeshCase(
  llm: BedrockLlmClient,
  backend: ToolBackend,
  workspaceRoot: string,
  testCase: BenchmarkCase,
  modelId: string,
  maxSteps: number,
  dryRun: boolean
): Promise<BenchmarkResult> {
  if (dryRun) {
    return {
      caseId: testCase.id,
      mode: "mesh",
      resolved: false,
      verifyPassed: false,
      summary: "DRY_RUN",
      error: null,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      filesChanged: [],
      toolCalls: 0,
      toolTrace: []
    };
  }

  const tools = (await backend.listTools()).filter((tool) => MESH_TOOLS.has(tool.name));
  const wireTools = toWireTools(tools);
  const toolSpecs = toToolSpecs(wireTools);
  const wireToolMap = new Map(wireTools.map((item) => [item.wireName, item]));
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolTrace: ToolTrace[] = [];
  const transcript: ConverseMessage[] = [
    {
      role: "user",
      content: [
        {
          text: [
            `Issue: ${testCase.title}`,
            testCase.issue,
            `Run this verifier before finishing: ${testCase.verifyCommand}`,
            "Make the minimum necessary change."
          ].join("\n")
        }
      ]
    }
  ];

  const startedAt = Date.now();
  let lastText = "";

  try {
    for (let step = 0; step < maxSteps; step += 1) {
      const response = await llm.converse(transcript, toolSpecs, MESH_SYSTEM_PROMPT, modelId);
      usage.inputTokens += response.usage?.inputTokens ?? 0;
      usage.outputTokens += response.usage?.outputTokens ?? 0;

      if (response.kind === "text") {
        lastText = response.text.trim();
        break;
      }

      lastText = (response.text ?? lastText).trim();
      const assistantContent: ContentBlock[] = [];
      if (response.text) assistantContent.push({ text: response.text });
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
        toolTrace.push({ name: response.name, ok: false });
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
        toolTrace.push({ name: selectedTool.tool.name, ok: true });
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
        toolTrace.push({ name: selectedTool.tool.name, ok: false });
      }
    }

    const verify = await runVerifyCommand(backend, testCase.verifyCommand);
    return {
      caseId: testCase.id,
      mode: "mesh",
      resolved: Boolean(verify.ok),
      verifyPassed: Boolean(verify.ok),
      summary: lastText || (verify.ok ? "Fixed and verified." : "No final summary."),
      error: verify.ok ? null : `Verifier failed: ${(verify.stderr || verify.stdout || "").slice(0, 400)}`,
      latencyMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      filesChanged: await compareChangedFiles(workspaceRoot, testCase.files),
      toolCalls: toolTrace.length,
      toolTrace
    };
  } catch (error) {
    return {
      caseId: testCase.id,
      mode: "mesh",
      resolved: false,
      verifyPassed: false,
      summary: lastText,
      error: (error as Error).message,
      latencyMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      filesChanged: await compareChangedFiles(workspaceRoot, testCase.files),
      toolCalls: toolTrace.length,
      toolTrace
    };
  }
}

function renderReport(modelId: string, results: BenchmarkResult[]): string {
  const direct = results.filter((result) => result.mode === "direct");
  const mesh = results.filter((result) => result.mode === "mesh");
  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const rate = (items: BenchmarkResult[]) => items.filter((item) => item.resolved).length / Math.max(items.length, 1);
  const lines = [
    "Mesh CLI SWE Benchmark",
    `Model: ${modelId}`,
    "",
    `${"case".padEnd(18)} ${"mode".padEnd(8)} ${"resolved".padStart(8)} ${"tokens".padStart(8)} ${"latency".padStart(8)} ${"tools".padStart(6)} details`
  ];

  for (const result of results) {
    lines.push(
      [
        result.caseId.padEnd(18),
        result.mode.padEnd(8),
        String(result.resolved).padStart(8),
        String(result.totalTokens).padStart(8),
        `${result.latencyMs}ms`.padStart(8),
        String(result.toolCalls).padStart(6),
        result.filesChanged.join(", ") || "-"
      ].join(" ")
    );
    if (result.error) {
      lines.push(`  error: ${result.error}`);
    } else {
      lines.push(`  summary: ${result.summary}`);
    }
    if (result.toolTrace.length > 0) {
      lines.push(`  toolTrace: ${result.toolTrace.map((entry) => `${entry.name}${entry.ok ? "" : "!"}`).join(" -> ")}`);
    }
  }

  lines.push("");
  lines.push(`Summary: direct resolved ${(rate(direct) * 100).toFixed(1)}%`);
  lines.push(`Summary: mesh resolved ${(rate(mesh) * 100).toFixed(1)}%`);
  lines.push(`Summary: direct avg tokens ${avg(direct.map((result) => result.totalTokens)).toFixed(0)}, mesh avg tokens ${avg(mesh.map((result) => result.totalTokens)).toFixed(0)}`);
  lines.push(`Summary: direct avg latency ${avg(direct.map((result) => result.latencyMs)).toFixed(0)}ms, mesh avg latency ${avg(mesh.map((result) => result.latencyMs)).toFixed(0)}ms`);
  return lines.join("\n");
}

async function saveResults(modelId: string, results: BenchmarkResult[], report: string): Promise<void> {
  const dir = path.join(process.cwd(), "benchmarks", "results");
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, "-");
  const base = `mesh-cli-swe-${sanitizeModelName(modelId)}-${stamp}`;
  await fs.writeFile(path.join(dir, `${base}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), modelId, results }, null, 2), "utf8");
  await fs.writeFile(path.join(dir, `${base}.md`), ["```", report, "```"].join("\n"), "utf8");
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const modelId = parseArgValue(argv, "--model") || DEFAULT_MODEL;
  const maxSteps = Number(parseArgValue(argv, "--steps") || DEFAULT_MAX_STEPS);
  const save = argv.includes("--save");
  const dryRun = argv.includes("--dry-run");
  const caseArg = parseArgValue(argv, "--cases");
  const allCases = await collectFixtureCases();
  const cases = caseArg ? allCases.filter((testCase) => caseArg.split(",").includes(testCase.id)) : allCases;

  const baseConfig = await loadConfig();
  const llm = new BedrockLlmClient({
    endpointBase: baseConfig.bedrock.endpointBase,
    bearerToken: baseConfig.bedrock.bearerToken,
    modelId,
    temperature: 0,
    maxTokens: 500
  });

  const results: BenchmarkResult[] = [];

  for (const testCase of cases) {
    const directWorkspace = await createWorkspace(testCase);
    const directConfig = createAppConfig(baseConfig, directWorkspace, modelId, maxSteps);
    const directBackend = new LocalToolBackend(directWorkspace, directConfig);

    try {
      await indexWorkspace(directBackend);
      results.push(await runDirectCase(llm, directBackend, directWorkspace, testCase, modelId, dryRun));
    } finally {
      await directBackend.close();
      await fs.rm(directWorkspace, { recursive: true, force: true });
    }

    const meshWorkspace = await createWorkspace(testCase);
    const meshConfig = createAppConfig(baseConfig, meshWorkspace, modelId, maxSteps);
    const meshBackend = new LocalToolBackend(meshWorkspace, meshConfig);

    try {
      await indexWorkspace(meshBackend);
      results.push(await runMeshCase(llm, meshBackend, meshWorkspace, testCase, modelId, maxSteps, dryRun));
    } finally {
      await meshBackend.close();
      await fs.rm(meshWorkspace, { recursive: true, force: true });
    }
  }

  const report = renderReport(modelId, results);
  process.stdout.write(`${report}\n`);
  if (save) await saveResults(modelId, results, report);
}

run().catch((error) => {
  process.stderr.write(`${(error as Error).stack || (error as Error).message}\n`);
  process.exitCode = 1;
});
