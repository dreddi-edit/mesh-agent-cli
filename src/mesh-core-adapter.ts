import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface MeshCoreModule {
  estimateTextTokens?: (value: string) => number;
  detectFileType?: (filePath: string, text?: string) => Record<string, unknown>;
  buildWorkspaceFileRecord?: (
    pathValue: string,
    rawText: string,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
  buildWorkspaceFileView?: (
    meta: unknown,
    view?: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
}

export interface MeshFileSummary {
  meshCoreAvailable: boolean;
  tokensEstimate: number;
  fileType: Record<string, unknown> | null;
  capsulePreview?: string;
  capsuleTier?: string;
  warning?: string;
}

export class MeshCoreAdapter {
  private readonly module: MeshCoreModule | null;
  private readonly loadError: string | null;

  constructor() {
    const require = createRequire(import.meta.url);
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(process.cwd(), "mesh-core/src/compression-core.cjs"),
      path.resolve(moduleDir, "../mesh-core/src/compression-core.cjs")
    ];

    try {
      let loaded: MeshCoreModule | null = null;
      let lastError = "";

      for (const candidate of candidates) {
        try {
          loaded = require(candidate) as MeshCoreModule;
          break;
        } catch (error) {
          lastError = (error as Error).message;
        }
      }

      if (!loaded) {
        throw new Error(lastError || "mesh-core module not found");
      }

      this.module = loaded;
      this.loadError = null;
    } catch (error) {
      this.module = null;
      this.loadError = (error as Error).message;
    }
  }

  get isAvailable(): boolean {
    return Boolean(this.module);
  }

  summarizeFile(filePath: string, text: string): Promise<MeshFileSummary> {
    return this.safeSummarizeFile(filePath, text);
  }

  private async safeSummarizeFile(filePath: string, text: string): Promise<MeshFileSummary> {
    const content = String(text ?? "");
    const fallbackTokens = Math.max(1, Math.ceil(Buffer.byteLength(content, "utf8") / 4));

    if (!this.module) {
      return {
        meshCoreAvailable: false,
        tokensEstimate: fallbackTokens,
        fileType: null,
        warning: this.loadError ? `mesh-core unavailable: ${this.loadError}` : "mesh-core unavailable"
      };
    }

    try {
      const tokens =
        typeof this.module.estimateTextTokens === "function"
          ? this.module.estimateTextTokens(content)
          : fallbackTokens;
      const fileType =
        typeof this.module.detectFileType === "function"
          ? this.module.detectFileType(filePath, content)
          : null;

      let capsulePreview = "";
      let capsuleTier = "";

      if (
        typeof this.module.buildWorkspaceFileRecord === "function" &&
        typeof this.module.buildWorkspaceFileView === "function"
      ) {
        const record = await this.module.buildWorkspaceFileRecord(filePath, content, {
          recordMode: "initial",
          defaultCapsuleTier: "medium"
        });
        const capsuleView = await this.module.buildWorkspaceFileView(record, "capsule", { tier: "medium" });
        capsulePreview = String(capsuleView.content ?? "").slice(0, 3000);
        capsuleTier = String(capsuleView.capsuleTier ?? "medium");
      }

      return {
        meshCoreAvailable: true,
        tokensEstimate: tokens,
        fileType,
        capsulePreview,
        capsuleTier
      };
    } catch (error) {
      return {
        meshCoreAvailable: true,
        tokensEstimate: fallbackTokens,
        fileType: null,
        warning: `mesh-core summarize failed: ${(error as Error).message}`
      };
    }
  }
}
