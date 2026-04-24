import { ToolBackend, ToolCallOpts, ToolDefinition } from "./tool-backend.js";

export class CompositeToolBackend implements ToolBackend {
  constructor(private readonly backends: ToolBackend[]) {}

  async listTools(): Promise<ToolDefinition[]> {
    const allTools: ToolDefinition[] = [];
    for (const backend of this.backends) {
      const tools = await backend.listTools();
      allTools.push(...tools);
    }
    // Remove duplicates by name
    return Array.from(new Map(allTools.map(t => [t.name, t])).values());
  }

  async callTool(name: string, args: Record<string, unknown>, opts?: ToolCallOpts): Promise<unknown> {
    for (const backend of this.backends) {
      const tools = await backend.listTools();
      if (tools.some(t => t.name === name)) {
        return backend.callTool(name, args, opts);
      }
    }
    throw new Error(`Tool not found: ${name}`);
  }

  async close(): Promise<void> {
    await Promise.all(this.backends.map(b => b.close()));
  }

  indexEverything?(): AsyncGenerator<{ current: number; total: number; path: string }> {
    for (const backend of this.backends) {
      if (backend.indexEverything) {
        return backend.indexEverything();
      }
    }
    return (async function* () {})();
  }
}
