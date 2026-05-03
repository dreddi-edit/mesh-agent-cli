import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const DOCTOR_NETWORK_TIMEOUT_MS = 3000;

export interface DoctorResult {
  ok: boolean;
  timestamp: string;
  checks: DoctorCheck[];
}

export interface DoctorCheck {
  id: string;
  title: string;
  status: "pass" | "warn" | "fail";
  message: string;
  details?: string[];
}

export class MeshDoctorEngine {
  constructor(private readonly config: AppConfig) {}

  async run(): Promise<DoctorResult> {
    const checks: DoctorCheck[] = await Promise.all([
      this.checkLocalEnvironment(),
      this.checkWorkspaceReadiness(),
      this.checkReleaseGuardrails(),
      this.checkProxyConnectivity(),
      this.checkAuthentication(),
      this.checkProviderHealth()
    ]);

    const ok = checks.every(c => c.status !== "fail");
    return {
      ok,
      timestamp: new Date().toISOString(),
      checks
    };
  }

  private async checkWorkspaceReadiness(): Promise<DoctorCheck> {
    const root = this.config.agent.workspaceRoot;
    const stateRoot = process.env.MESH_STATE_DIR || path.join(os.homedir(), ".config", "mesh");
    const details: string[] = [`Workspace: ${root}`, `State root: ${stateRoot}`];
    let status: "pass" | "warn" | "fail" = "pass";

    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) {
        return {
          id: "workspace",
          title: "Workspace Readiness",
          status: "fail",
          message: "Workspace root is not a directory.",
          details
        };
      }
      await fs.access(root, fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      return {
        id: "workspace",
        title: "Workspace Readiness",
        status: "fail",
        message: "Workspace root is not readable and writable.",
        details: [...details, (error as Error).message]
      };
    }

    try {
      await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
      await fs.access(stateRoot, fsConstants.R_OK | fsConstants.W_OK);
      details.push("State directory is writable.");
    } catch (error) {
      status = "warn";
      details.push(`State directory warning: ${(error as Error).message}`);
    }

    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
      details.push(`Git repository: ${stdout.trim() === "true" ? "yes" : "no"}`);
    } catch {
      status = "warn";
      details.push("Git repository: no or unavailable");
    }

    return {
      id: "workspace",
      title: "Workspace Readiness",
      status,
      message: status === "pass" ? "Workspace and Mesh state paths are writable." : "Workspace works, but some persistence features may be degraded.",
      details
    };
  }

  private async checkReleaseGuardrails(): Promise<DoctorCheck> {
    const details = [
      `Cloud cache: ${this.config.agent.enableCloudCache ? "enabled" : "disabled"}`,
      `Telemetry contribution: ${this.config.telemetry.contribute ? "enabled" : "disabled"}`,
      `Watchers: ${truthyEnv("MESH_DISABLE_WATCHERS") ? "disabled" : "enabled"}`,
      `Background resolver: ${truthyEnv("MESH_ENABLE_BACKGROUND_RESOLVER") ? "enabled" : "disabled"}`,
      `Embeddings: ${truthyEnv("MESH_ENABLE_EMBEDDINGS") ? "enabled" : "disabled"}`
    ];

    let status: "pass" | "warn" | "fail" = "pass";
    if (this.config.telemetry.contribute) {
      status = "warn";
      details.push("Telemetry contribution is opt-in and enabled for this workspace.");
    }
    if (truthyEnv("MESH_ENABLE_BACKGROUND_RESOLVER")) {
      status = "warn";
      details.push("Background resolver may run diagnostics after file changes.");
    }
    if (truthyEnv("MESH_ENABLE_EMBEDDINGS")) {
      status = "warn";
      details.push("Embeddings may use local model loading or a configured remote provider.");
    }

    return {
      id: "guardrails",
      title: "Release Guardrails",
      status,
      message: status === "pass" ? "Costly and experimental background features are off by default." : "One or more opt-in features may affect cost, CPU, or privacy.",
      details
    };
  }

  private async checkLocalEnvironment(): Promise<DoctorCheck> {
    const details: string[] = [];
    let status: "pass" | "warn" | "fail" = "pass";

    try {
      const nodeVersion = process.version;
      details.push(`Node.js: ${nodeVersion}`);
      
      const { stdout: gitVersion } = await execFileAsync("git", ["--version"]);
      details.push(`Git: ${gitVersion.trim()}`);

      const { stdout: npmVersion } = await execFileAsync("npm", ["--version"]);
      details.push(`npm: ${npmVersion.trim()}`);
    } catch (err) {
      status = "warn";
      details.push(`Error checking local tools: ${(err as Error).message}`);
    }

    return {
      id: "local_env",
      title: "Local Environment",
      status,
      message: status === "pass" ? "Local tools are available." : "Some local tools might be missing.",
      details
    };
  }

  private async checkProxyConnectivity(): Promise<DoctorCheck> {
    const endpoint = this.config.bedrock.endpointBase;
    if (!endpoint) {
      return {
        id: "proxy_conn",
        title: "Proxy Connectivity",
        status: "fail",
        message: "No endpointBase configured in config.toml or .env."
      };
    }

    try {
      const start = Date.now();
      const res = await fetchWithTimeout(endpoint.replace(/\/+$/, "") + "/brain/health", { method: "GET" }).catch(() => null);
      const latency = Date.now() - start;

      if (res && res.ok) {
        return {
          id: "proxy_conn",
          title: "Proxy Connectivity",
          status: "pass",
          message: `Proxy is reachable (Latency: ${latency}ms).`,
          details: [`Endpoint: ${endpoint}`]
        };
      } else {
        return {
          id: "proxy_conn",
          title: "Proxy Connectivity",
          status: "fail",
          message: `Proxy at ${endpoint} returned status ${res?.status || "unknown"}.`,
          details: [`Endpoint: ${endpoint}`]
        };
      }
    } catch (err) {
      return {
        id: "proxy_conn",
        title: "Proxy Connectivity",
        status: "fail",
        message: `Failed to connect to proxy: ${(err as Error).message}`,
        details: [`Endpoint: ${endpoint}`]
      };
    }
  }

  private async checkAuthentication(): Promise<DoctorCheck> {
    const token = this.config.bedrock.bearerToken;
    if (!token) {
      return {
        id: "auth",
        title: "Authentication",
        status: "fail",
        message: "No MESH_BEARER_TOKEN configured."
      };
    }

    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return {
          id: "auth",
          title: "Authentication",
          status: "warn",
          message: "Token is not a standard JWT format.",
          details: ["Token might be a custom static key."]
        };
      }

      const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
      const exp = payload.exp ? new Date(payload.exp * 1000) : null;
      const isExpired = exp ? exp < new Date() : false;

      return {
        id: "auth",
        title: "Authentication",
        status: isExpired ? "fail" : "pass",
        message: isExpired ? "Your session token has expired." : "Authentication token is valid.",
        details: [
          `User ID: ${payload.sub || "unknown"}`,
          `Expires: ${exp ? exp.toLocaleString() : "never"}`
        ]
      };
    } catch {
      return {
        id: "auth",
        title: "Authentication",
        status: "pass",
        message: "Authentication token present.",
        details: ["Token format: non-JWT or opaque."]
      };
    }
  }

  private async checkProviderHealth(): Promise<DoctorCheck> {
    const endpoint = this.config.bedrock.endpointBase;
    const token = this.config.bedrock.bearerToken;
    if (!endpoint || !token) {
      return {
        id: "providers",
        title: "Model Providers",
        status: "fail",
        message: "Connectivity or Auth missing, cannot check providers."
      };
    }

    const details: string[] = [];
    let status: "pass" | "warn" | "fail" = "pass";

    // Check Bedrock (Claude)
    try {
      const bedrockRes = await fetchWithTimeout(endpoint.replace(/\/+$/, "") + "/model/us.anthropic.claude-haiku-4-5-20251001-v1:0/converse", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: [{ text: "ping" }] }],
          inferenceConfig: { maxTokens: 1, temperature: 0 }
        })
      });

      if (bedrockRes.ok) {
        details.push("✅ Bedrock (Claude): Accessible");
      } else {
        const err = await bedrockRes.text();
        details.push(`❌ Bedrock (Claude): Failed (${bedrockRes.status}) - ${err.slice(0, 100)}`);
        status = "warn";
      }
    } catch (err) {
      details.push(`❌ Bedrock (Claude): Error - ${(err as Error).message}`);
      status = "warn";
    }

    // Check NVIDIA (Minimax/Llama)
    try {
      const nvidiaRes = await fetchWithTimeout(endpoint.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          model: "meta/llama-3.3-70b-instruct",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        })
      });

      if (nvidiaRes.ok) {
        details.push("✅ NVIDIA (Minimax/Llama): Accessible");
      } else {
        const err = await nvidiaRes.text();
        details.push(`❌ NVIDIA (Minimax/Llama): Failed (${nvidiaRes.status}) - ${err.slice(0, 100)}`);
        status = "warn";
      }
    } catch (err) {
      details.push(`❌ NVIDIA (Minimax/Llama): Error - ${(err as Error).message}`);
      status = "warn";
    }

    return {
      id: "providers",
      title: "Model Providers",
      status,
      message: status === "pass" ? "All providers are healthy." : "Some providers are unreachable.",
      details
    };
  }
}

function truthyEnv(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name] ?? "");
}

async function fetchWithTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCTOR_NETWORK_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
