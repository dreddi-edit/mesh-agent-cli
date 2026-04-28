import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppConfig } from "./config.js";
import { isNvidiaHostedModel } from "./nvidia-services.js";

const execFileAsync = promisify(execFile);

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
      const res = await fetch(endpoint.replace(/\/+$/, "") + "/brain/health", { method: "GET" }).catch(() => null);
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
      const bedrockRes = await fetch(endpoint.replace(/\/+$/, "") + "/model/us.anthropic.claude-haiku-4-5-20251001-v1:0/converse", {
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
      const nvidiaRes = await fetch(endpoint.replace(/\/+$/, "") + "/chat/completions", {
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
