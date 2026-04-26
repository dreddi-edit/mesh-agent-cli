import { promises as fs } from "node:fs";
import path from "node:path";
import { collectWorkspaceFiles, lineNumberAt, readJson, writeJson } from "./common.js";

interface SymbolMemory {
  symbol: string;
  file: string;
  line: number;
  kind: string;
  notes: Array<{ at: string; note: string; source: string }>;
}

export class ConversationalCodebaseEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "ask").trim().toLowerCase();
    if (action === "status") return this.status();
    if (action === "record") return this.record(args);
    if (action === "map") return this.map();
    if (action !== "ask") throw new Error("workspace.conversational_codebase action must be ask|record|map|status");

    const query = String(args.query ?? args.symbol ?? "").trim();
    if (!query) throw new Error("workspace.conversational_codebase ask requires query or symbol");
    const memory = await this.loadMemory();
    const symbols = memory.symbols.length > 0 ? memory.symbols : (await this.rebuildMemory()).symbols;
    const matches = rankSymbols(symbols, query).slice(0, 8);
    const answer = matches.length === 0
      ? `I do not have a symbol-level memory for "${query}" yet. Run action=map to refresh the codebase memory.`
      : buildAnswer(query, matches);
    const result = {
      ok: true,
      action,
      query,
      answer,
      matches,
      memoryPath: ".mesh/conversations/symbol-memory.json"
    };
    await writeJson(path.join(this.workspaceRoot, ".mesh", "conversations", "last-answer.json"), result);
    return result;
  }

  private async record(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args.symbol ?? "").trim();
    const note = String(args.note ?? "").trim();
    if (!symbol || !note) throw new Error("workspace.conversational_codebase record requires symbol and note");
    const memory = await this.loadMemory();
    let target = memory.symbols.find((item) => item.symbol === symbol);
    if (!target) {
      target = { symbol, file: "unknown", line: 0, kind: "unknown", notes: [] };
      memory.symbols.push(target);
    }
    target.notes.unshift({ at: new Date().toISOString(), note, source: "user" });
    target.notes = target.notes.slice(0, 25);
    await writeJson(this.memoryPath(), memory);
    return { ok: true, action: "record", symbol, notes: target.notes.length, memoryPath: ".mesh/conversations/symbol-memory.json" };
  }

  private async map(): Promise<Record<string, unknown>> {
    const memory = await this.rebuildMemory();
    return {
      ok: true,
      action: "map",
      symbols: memory.symbols.length,
      memoryPath: ".mesh/conversations/symbol-memory.json"
    };
  }

  private async status(): Promise<Record<string, unknown>> {
    const memory = await this.loadMemory();
    return { ok: true, action: "status", symbols: memory.symbols.length, memoryPath: ".mesh/conversations/symbol-memory.json" };
  }

  private async rebuildMemory(): Promise<{ symbols: SymbolMemory[]; updatedAt: string }> {
    const previous = await this.loadMemory();
    const notesByKey = new Map(previous.symbols.map((item) => [`${item.file}:${item.symbol}`, item.notes]));
    const symbols: SymbolMemory[] = [];
    const files = await collectWorkspaceFiles(this.workspaceRoot, { maxFiles: 1500 });
    for (const file of files) {
      const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
      for (const symbol of extractSymbols(file, raw)) {
        symbol.notes = notesByKey.get(`${symbol.file}:${symbol.symbol}`) ?? [];
        symbols.push(symbol);
      }
    }
    const memory = { symbols, updatedAt: new Date().toISOString() };
    await writeJson(this.memoryPath(), memory);
    return memory;
  }

  private async loadMemory(): Promise<{ symbols: SymbolMemory[]; updatedAt?: string }> {
    return readJson(this.memoryPath(), { symbols: [] });
  }

  private memoryPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "conversations", "symbol-memory.json");
  }
}

function extractSymbols(file: string, raw: string): SymbolMemory[] {
  const symbols: SymbolMemory[] = [];
  const re = /\b(?:export\s+)?(?:async\s+)?(function|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of raw.matchAll(re)) {
    symbols.push({
      symbol: match[2],
      file,
      line: lineNumberAt(raw, match.index ?? 0),
      kind: match[1],
      notes: []
    });
  }
  return symbols;
}

function rankSymbols(symbols: SymbolMemory[], query: string): SymbolMemory[] {
  const normalized = query.toLowerCase();
  return [...symbols]
    .map((item) => ({
      item,
      score:
        (item.symbol.toLowerCase() === normalized ? 100 : 0) +
        (item.symbol.toLowerCase().includes(normalized) ? 40 : 0) +
        (item.file.toLowerCase().includes(normalized) ? 20 : 0) +
        item.notes.reduce((sum, note) => sum + (note.note.toLowerCase().includes(normalized) ? 10 : 0), 0)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item);
}

function buildAnswer(query: string, matches: SymbolMemory[]): string {
  const top = matches[0];
  const notes = top.notes.slice(0, 3).map((note) => ` note: ${note.note}`).join("");
  return `For "${query}", the strongest match is ${top.symbol} (${top.kind}) in ${top.file}:${top.line}.${notes}`;
}
