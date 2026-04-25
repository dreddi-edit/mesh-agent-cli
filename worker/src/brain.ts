type BrainPattern = {
  id: string;
  errorSignature: string;
  diffPattern: string;
  verificationResult: Record<string, unknown>;
  createdAt: string;
};

const memory = new Map<string, BrainPattern[]>();
const dnaMemory: Array<{ dna: Record<string, string>; rules: string[] }> = [];

export async function handleBrainRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/brain/contribute") {
    const payload = await request.json() as {
      workspaceFingerprint?: string;
      errorSignature?: string;
      diffPattern?: string;
      verificationResult?: Record<string, unknown>;
    };
    if (!payload.errorSignature || !payload.diffPattern) {
      return json({ error: "invalid_payload" }, 400);
    }
    const key = payload.errorSignature.slice(0, 512);
    const item: BrainPattern = {
      id: `brain-${Date.now().toString(36)}`,
      errorSignature: payload.errorSignature,
      diffPattern: payload.diffPattern,
      verificationResult: payload.verificationResult ?? {},
      createdAt: new Date().toISOString()
    };
    const rows = memory.get(key) ?? [];
    rows.unshift(item);
    memory.set(key, rows.slice(0, 50));
    return json({ ok: true, id: item.id });
  }

  if (request.method === "POST" && url.pathname === "/brain/query") {
    const payload = await request.json() as { errorSignature?: string; limit?: number };
    const key = String(payload.errorSignature ?? "").slice(0, 512);
    const limit = Math.max(1, Math.min(Number(payload.limit) || 5, 20));
    const rows = memory.get(key) ?? [];
    return json({
      ok: true,
      patterns: rows.slice(0, limit).map((row, index) => ({
        id: row.id,
        score: Math.max(0.3, 1 - index * 0.1),
        errorSignature: row.errorSignature,
        diffPattern: row.diffPattern,
        fixSummary: "Promoted patch from another workspace",
        successRate: row.verificationResult?.verdict === "pass" ? 1 : 0.5,
        usageCount: 1,
        verification: row.verificationResult
      }))
    });
  }

  if (request.method === "POST" && url.pathname === "/brain/dna/query") {
    const payload = await request.json() as {
      dna?: Record<string, string>;
      threshold?: number;
    };
    const dna = payload.dna ?? {};
    const threshold = Number(payload.threshold) || 0.85;
    const cohort = dnaMemory
      .map((entry) => ({
        similarity: dnaSimilarity(entry.dna, dna),
        rules: entry.rules
      }))
      .filter((entry) => entry.similarity >= threshold)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, 25);
    return json({ ok: true, cohort });
  }

  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*"
    }
  });
}

function dnaSimilarity(left: Record<string, string>, right: Record<string, string>): number {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  if (keys.size === 0) return 0;
  let matches = 0;
  for (const key of keys) {
    if ((left[key] ?? "") === (right[key] ?? "")) {
      matches += 1;
    }
  }
  return matches / keys.size;
}
