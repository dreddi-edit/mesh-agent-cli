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
  fixes?: DoctorFix[];
}

export interface DoctorFix {
  id: string;
  title: string;
  description: string;
  automatic: boolean;
  command?: string;
}

export interface DoctorFixResult {
  id: string;
  ok: boolean;
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

  async autoFix(): Promise<DoctorFixResult[]> {
    const root = this.config.agent.workspaceRoot;
    const meshDir = path.join(root, ".mesh");
    const stateRoot = process.env.MESH_STATE_DIR || path.join(os.homedir(), ".config", "mesh");
    const results: DoctorFixResult[] = [];

    results.push(await tryFix("create_state_dir", `Ensured Mesh state directory exists: ${stateRoot}`, async () => {
      await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
      await fs.chmod(stateRoot, 0o700).catch(() => undefined);
    }));

    results.push(await tryFix("create_workspace_mesh_dir", `Ensured workspace .mesh directory exists: ${meshDir}`, async () => {
      await fs.mkdir(meshDir, { recursive: true });
    }));

    results.push(await tryFix("write_workspace_config", "Ensured workspace .mesh/config.json exists.", async () => {
      const configPath = path.join(meshDir, "config.json");
      try {
        await fs.access(configPath, fsConstants.F_OK);
      } catch {
        await fs.writeFile(
          configPath,
          JSON.stringify({
            modelId: this.config.bedrock.modelId,
            themeColor: this.config.agent.themeColor,
            enableCloudCache: this.config.agent.enableCloudCache,
            initializedAt: new Date().toISOString()
          }, null, 2) + "\n",
          { encoding: "utf8", mode: 0o600 }
        );
      }
    }));

    results.push(await tryFix("write_onboarding_state", "Wrote latest first-run state marker.", async () => {
      await fs.writeFile(
        path.join(meshDir, "first-run.json"),
        JSON.stringify({
          version: 1,
          lastDoctorFixAt: new Date().toISOString(),
          workspaceRoot: root
        }, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 }
      );
    }));

    return results;
  }

  private async checkWorkspaceReadiness(): Promise<DoctorCheck> {
    const root = this.config.agent.workspaceRoot;
    const meshDir = path.join(root, ".mesh");
    const stateRoot = process.env.MESH_STATE_DIR || path.join(os.homedir(), ".config", "mesh");
    const details: string[] = [`Workspace: ${root}`, `Mesh dir: ${meshDir}`, `State root: ${stateRoot}`];
    const fixes: DoctorFix[] = [];
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
      fixes.push({
        id: "create_state_dir",
        title: "Create Mesh state directory",
        description: `Create and chmod ${stateRoot}.`,
        automatic: true
      });
    }

    try {
      await fs.access(meshDir, fsConstants.R_OK | fsConstants.W_OK);
      details.push("Workspace .mesh directory is writable.");
    } catch {
      status = "warn";
      details.push("Workspace .mesh directory is missing or not writable.");
      fixes.push({
        id: "create_workspace_mesh_dir",
        title: "Create workspace .mesh directory",
        description: `Create ${meshDir}.`,
        automatic: true
      });
    }

    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
      details.push(`Git repository: ${stdout.trim() === "true" ? "yes" : "no"}`);
    } catch {
      status = "warn";
      details.push("Git repository: no or unavailable");
      fixes.push({
        id: "git_init_manual",
        title: "Initialize Git repository",
        description: "Mesh can work without Git, but timelines, diffs, and rollback are much safer in a Git worktree.",
        automatic: false,
        command: "git init"
      });
    }

    return {
      id: "workspace",
      title: "Workspace Readiness",
      status,
      message: status === "pass" ? "Workspace and Mesh state paths are writable." : "Workspace works, but some persistence features may be degraded.",
      details,
      fixes
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
    const fixes: DoctorFix[] = [];

    try {
      const nodeVersion = process.version;
      details.push(`Node.js: ${nodeVersion}`);
      const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
      if (!Number.isFinite(major) || major < 20) {
        status = "fail";
        fixes.push({
          id: "upgrade_node_manual",
          title: "Upgrade Node.js",
          description: "Mesh requires Node.js >=20.",
          automatic: false,
          command: "nvm install 20 && nvm use 20"
        });
      }
      
      const { stdout: gitVersion } = await execFileAsync("git", ["--version"]);
      details.push(`Git: ${gitVersion.trim()}`);

      const { stdout: npmVersion } = await execFileAsync("npm", ["--version"]);
      details.push(`npm: ${npmVersion.trim()}`);

      const { stdout: npmPrefix } = await execFileAsync("npm", ["config", "get", "prefix"]);
      const npmBin = path.join(npmPrefix.trim(), "bin");
      const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
      details.push(`npm global bin: ${npmBin}`);
      if (!pathEntries.includes(npmBin)) {
        status = status === "fail" ? "fail" : "warn";
        details.push("npm global bin is not on PATH; global mesh installs may not be shell-visible.");
        fixes.push({
          id: "npm_path_manual",
          title: "Add npm global bin to PATH",
          description: "Add npm's global bin directory to your shell PATH.",
          automatic: false,
          command: `export PATH="${npmBin}:$PATH"`
        });
      }
    } catch (err) {
      status = status === "fail" ? "fail" : "warn";
      details.push(`Error checking local tools: ${(err as Error).message}`);
    }

    return {
      id: "local_env",
      title: "Local Environment",
      status,
      message: status === "pass" ? "Local tools are available." : "Some local tools might be missing.",
      details,
      fixes
    };
  }

  private async checkProxyConnectivity(): Promise<DoctorCheck> {
    const endpoint = this.config.bedrock.endpointBase;
    if (!endpoint) {
      return {
        id: "proxy_conn",
        title: "Proxy Connectivity",
        status: "fail",
        message: "No endpointBase configured in config.toml or .env.",
        fixes: [{
          id: "configure_endpoint_manual",
          title: "Configure Mesh endpoint",
          description: "Set BEDROCK_ENDPOINT or run /setup to configure a custom endpoint.",
          automatic: false,
          command: "mesh /setup"
        }]
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
        message: "No MESH_BEARER_TOKEN configured.",
        fixes: [{
          id: "login_manual",
          title: "Authenticate Mesh",
          description: "Run mesh and complete the login flow, or configure a bearer token.",
          automatic: false,
          command: "mesh"
        }]
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
        message: "Connectivity or Auth missing, cannot check providers.",
        fixes: [{
          id: "run_doctor_manual",
          title: "Fix proxy or auth first",
          description: "Provider checks require both endpoint connectivity and authentication.",
          automatic: false,
          command: "mesh doctor fix"
        }]
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

async function tryFix(id: string, successMessage: string, action: () => Promise<void>): Promise<DoctorFixResult> {
  try {
    await action();
    return { id, ok: true, message: successMessage };
  } catch (error) {
    return {
      id,
      ok: false,
      message: `Failed to apply ${id}.`,
      details: [(error as Error).message]
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
