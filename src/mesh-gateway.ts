import zlib from "node:zlib";
import { promisify } from "node:util";
import crypto from "node:crypto";

const SEEN_FILES_HASHES = new Set<string>();

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

function normalizePayloadText(rawText: string): { normalized: string; type: "json" | "text" } {
  const text = String(rawText ?? "");
  try {
    const parsed = JSON.parse(text);
    return {
      normalized: JSON.stringify(parsed),
      type: "json"
    };
  } catch {
    // Fallback for non-JSON content.
    return {
      normalized: text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n"),
      type: "text"
    };
  }
}

export interface MeshCompressedPayload {
  buffer: Buffer;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  type: "json" | "text";
}

export async function compressMeshPayload(rawText: string): Promise<MeshCompressedPayload> {
  const normalized = normalizePayloadText(rawText);
  const compressedBuffer = await brotliCompress(Buffer.from(normalized.normalized, "utf8"), {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11
    }
  });

  const originalSize = Buffer.byteLength(rawText, "utf8");
  const compressedSize = compressedBuffer.length;
  const ratio = compressedSize > 0 ? originalSize / compressedSize : 1;

  return {
    buffer: compressedBuffer,
    originalSize,
    compressedSize,
    ratio,
    type: normalized.type
  };
}

export async function decompressMeshPayload(compressedBuffer: Buffer): Promise<string> {
  const decompressed = await brotliDecompress(compressedBuffer);
  return decompressed.toString("utf8");
}

export async function buildLlmSafeMeshContext(
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolResult: unknown,
  maxInlineChars = 4000
): Promise<string> {
  let serialized = JSON.stringify(toolResult);

  // Differential Sync Logic
  if (toolName === "workspace.read_file" && serialized.length > 500) {
    const path = String(toolArgs.path ?? "unknown");
    const fingerprint = crypto.createHash("md5").update(path + ":" + serialized).digest("hex");
    if (SEEN_FILES_HASHES.has(fingerprint)) {
      serialized = `{"note": "[DIFFERENTIAL SYNC] File ${path} content is already in context. Omitted."}`;
    } else {
      SEEN_FILES_HASHES.add(fingerprint);
    }
  }

  const compressed = await compressMeshPayload(serialized);
  const normalized = await decompressMeshPayload(compressed.buffer);

  if (normalized.length <= maxInlineChars) {
    return [
      `Tool called: ${toolName}`,
      `Arguments: ${JSON.stringify(toolArgs)}`,
      `Result: ${normalized}`,
      `MeshCompression: original=${compressed.originalSize}B compressed=${compressed.compressedSize}B ratio=${compressed.ratio.toFixed(2)}x type=${compressed.type}`
    ].join("\n");
  }

  const head = normalized.slice(0, Math.floor(maxInlineChars * 0.6));
  const tail = normalized.slice(-Math.floor(maxInlineChars * 0.25));

  return [
    `Tool called: ${toolName}`,
    `Arguments: ${JSON.stringify(toolArgs)}`,
    `Result: [mesh-compressed preview]`,
    `Head: ${head}`,
    `Tail: ${tail}`,
    `MeshCompression: original=${compressed.originalSize}B compressed=${compressed.compressedSize}B ratio=${compressed.ratio.toFixed(2)}x type=${compressed.type}`,
    `ResultNote: full tool payload omitted from LLM context due to size`
  ].join("\n");
}
