import { handleBrainRequest } from "./brain";

/**
 * Mesh LLM Proxy — Cloudflare Worker
 *
 * Forwards Bedrock Converse API requests to bedrock-runtime, injecting the
 * shared Bedrock API key (Bearer) server-side so mesh-agent-cli end users
 * need zero AWS credentials.
 *
 * Endpoint shape:
 *   POST /model/{modelId}/converse
 *
 * Secrets (set via `wrangler secret put ...`):
 *   BEDROCK_API_KEY   — AWS Bedrock API key (Bearer token)
 *
 * Vars (set in wrangler.toml [vars]):
 *   BEDROCK_REGION    — default "us-east-1"
 *   ALLOWED_MODELS    — comma-separated allowlist of Bedrock model IDs
 *                       (empty / unset = allow all)
 *   RATE_LIMIT_PER_MIN — per-IP request cap per rolling minute (default 30)
 */

export interface Env {
  BEDROCK_API_KEY: string;
  NVIDIA_API_KEY?: string;
  SUPABASE_JWT_SECRET: string;
  BEDROCK_REGION?: string;
  ALLOWED_MODELS?: string;
  RATE_LIMIT_PER_MIN?: string;
  RATE_LIMIT?: KVNamespace;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

const CONVERSE_PATH_RE = /^\/model\/([^/]+)\/converse$/;
const OPENAI_CHAT_PATH = "/chat/completions";
const OPENAI_EMBED_PATH = "/embeddings";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const brainResponse = await handleBrainRequest(req);
    if (brainResponse) {
      return brainResponse;
    }

    if (req.method === "OPTIONS") {
      return corsPreflight();
    }

    if (req.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "unauthorized", hint: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.split(" ")[1];
    const payload = await verifySupabaseJwt(token, env.SUPABASE_JWT_SECRET);
    if (!payload || !payload.sub) {
      return json({ error: "unauthorized", hint: "Invalid JWT" }, 401);
    }

    const userId = payload.sub;
    const plan = payload.app_metadata?.plan || "free";

    const url = new URL(req.url);
    const converseMatch = CONVERSE_PATH_RE.exec(url.pathname);
    const isOpenAiChat = url.pathname === OPENAI_CHAT_PATH;
    const isOpenAiEmbed = url.pathname === OPENAI_EMBED_PATH;

    if (!converseMatch && !isOpenAiChat && !isOpenAiEmbed) {
      return json(
        { error: "not_found", hint: "Use POST /model/{modelId}/converse OR /chat/completions OR /embeddings" },
        404
      );
    }

    // Tiered Rate Limits (Requests per minute & per day)
    let rpmLimit = 10;
    let rpdLimit = 100; // Requests per day

    if (plan === "alpha" || plan === "pro") {
      rpmLimit = 60;
      rpdLimit = 1000;
    } else if (plan === "unlimited" || plan === "admin") {
      rpmLimit = 500;
      rpdLimit = 10000;
    }

    const rateHit = await checkTieredRateLimit(env.RATE_LIMIT, userId, rpmLimit, rpdLimit);
    if (!rateHit.ok) {
      return json(
        { error: "rate_limited", reason: rateHit.reason, retryAfterSeconds: rateHit.retryAfter },
        429,
        { "retry-after": String(rateHit.retryAfter) }
      );
    }

    // Handle OpenAI-compatible NVIDIA requests
    if (isOpenAiChat || isOpenAiEmbed) {
      if (!env.NVIDIA_API_KEY) {
        return json({ error: "server_misconfigured_no_nvidia_key" }, 500);
      }
      
      const target = `https://integrate.api.nvidia.com/v1${url.pathname}`;
      const bodyText = await req.text();

      const upstream = await fetch(target, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${env.NVIDIA_API_KEY}`,
          "content-type": "application/json"
        },
        body: bodyText
      });

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*"
        }
      });
    }

    // Handle Bedrock Converse requests
    const modelId = decodeURIComponent(converseMatch![1]);
    if (!isModelAllowed(modelId, env.ALLOWED_MODELS)) {
      return json({ error: "model_not_allowed", modelId }, 403);
    }

    if (!env.BEDROCK_API_KEY) {
      return json({ error: "server_misconfigured_no_bedrock_key" }, 500);
    }

    const region = env.BEDROCK_REGION || "us-east-1";
    const target = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(
      modelId
    )}/converse`;

    const bodyText = await req.text();

    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.BEDROCK_API_KEY}`,
        "content-type": "application/json"
      },
      body: bodyText
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*"
      }
    });
  }
};

async function verifySupabaseJwt(token: string, secret: string): Promise<any> {
  if (!secret) return null;
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) return null;

  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    
    const signature = base64UrlToUint8Array(signatureB64);
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const isValid = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!isValid) return null;

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
    return payload;
  } catch (err) {
    return null;
  }
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isModelAllowed(modelId: string, allowlist?: string): boolean {
  if (!allowlist || !allowlist.trim()) {
    return true;
  }
  const allowed = allowlist
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(modelId);
}

async function checkRateLimit(
  kv: KVNamespace | undefined,
  id: string,
  limitPerMinute: number
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  if (!kv) {
    return { ok: true };
  }
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `rl:${id}:${bucket}`;
  const current = Number((await kv.get(key)) || "0");
  if (current >= limitPerMinute) {
    return { ok: false, retryAfter: 60 - (Math.floor(Date.now() / 1000) % 60) };
  }
  await kv.put(key, String(current + 1), { expirationTtl: 120 });
  return { ok: true };
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...extraHeaders
    }
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "86400"
    }
  });
}

ponse(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...extraHeaders
    }
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "86400"
    }
  });
}

