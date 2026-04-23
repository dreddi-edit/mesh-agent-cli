export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolBackend {
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  indexEverything?(): AsyncGenerator<{ current: number; total: number; path: string }>;
}
