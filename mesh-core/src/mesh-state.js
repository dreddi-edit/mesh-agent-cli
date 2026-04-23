/**
 * MESH Worker — Shared workspace state, constants, and init-time utilities.
 * Single source of truth for mutable in-memory state during worker operation.
 * Imported by workspace-helpers.js, workspace-operations.js, and server.js.
 * Node ESM module instances are cached, so all importers share the same objects.
 */

import zlib from 'zlib';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const { createWorkspaceMetadataStore } = _require('../../workspace-metadata-store.cjs');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Init-time utilities — needed to compute constants at module load
// ---------------------------------------------------------------------------

function clampBrotliQuality(rawValue, fallback) {
    const numeric = Number(rawValue);
    const selected = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
    return Math.min(11, Math.max(0, selected));
}

function parseIntegerInRange(rawValue, fallback, min, max) {
    const numeric = Number(rawValue);
    const selected = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
    return Math.min(max, Math.max(min, selected));
}

function toSafePath(rawPath) {
    const input = String(rawPath || '').replace(/\\/g, '/').trim();
    if (!input) return '';
    const normalized = path.posix.normalize(`/${input}`).replace(/^\/+/, '');
    return normalized === '.' ? '' : normalized;
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const WORKSPACE_CACHE_FILE               = path.join(__dirname, '..', '.mesh-worker-workspace-cache.json');
export const WORKSPACE_BROTLI_QUALITY           = clampBrotliQuality(process.env.MESH_WORKSPACE_BROTLI_QUALITY, 5);
export const WORKSPACE_INITIAL_BROTLI_QUALITY   = clampBrotliQuality(process.env.MESH_WORKSPACE_INITIAL_BROTLI_QUALITY, 3);
const RAW_WORKSPACE_INDEX_PARALLELISM           = process.env.MESH_WORKSPACE_INDEX_PARALLELISM;
export const WORKSPACE_INDEX_PARALLELISM        = parseIntegerInRange(process.env.MESH_WORKSPACE_INDEX_PARALLELISM, 8, 1, 24);
export const WORKSPACE_READ_CONCURRENCY         = parseIntegerInRange(process.env.MESH_WORKSPACE_READ_CONCURRENCY, RAW_WORKSPACE_INDEX_PARALLELISM !== undefined ? WORKSPACE_INDEX_PARALLELISM : 16, 1, 64);
export const WORKSPACE_BUILD_CONCURRENCY        = parseIntegerInRange(process.env.MESH_WORKSPACE_BUILD_CONCURRENCY, RAW_WORKSPACE_INDEX_PARALLELISM !== undefined ? WORKSPACE_INDEX_PARALLELISM : 6, 1, 32);
export const WORKSPACE_ENRICH_CONCURRENCY       = parseIntegerInRange(process.env.MESH_WORKSPACE_ENRICH_CONCURRENCY, RAW_WORKSPACE_INDEX_PARALLELISM !== undefined ? Math.min(WORKSPACE_INDEX_PARALLELISM, 16) : 4, 1, 24);
export const WORKSPACE_PERF_LOG_ENABLED         = ['1', 'true', 'yes', 'on', 'enabled'].includes(String(process.env.MESH_WORKSPACE_PERF_LOG || '').trim().toLowerCase());
export const WORKSPACE_SOURCE_UPLOAD            = 'upload';
export const WORKSPACE_SOURCE_LOCAL_PATH        = 'local-path';
export const LOCAL_WORKSPACE_SKIP_EXTENSIONS    = /\.(png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot|mp4|mp3|zip|gz|tar|lock)$/i;
export const LOCAL_WORKSPACE_SKIP_DIRS          = /(^|\/)(node_modules|\.git|dist|build|\.next|__pycache__)(\/|$)/;
export const LOCAL_WORKSPACE_MAX_FILE_CHARS     = 1_000_000;
export const BLOB_WORKSPACE_SOURCE_NOTE = `[mesh note] File truncated during indexing because it exceeded ${LOCAL_WORKSPACE_MAX_FILE_CHARS.toLocaleString()} characters.`;

// ---------------------------------------------------------------------------
// Shared mutable state
// ---------------------------------------------------------------------------

export const workspaceState = {
    folderName:         null,
    rootPath:           null,
    workspaceId:        null,
    sessionId:          null,
    sourceKind:         WORKSPACE_SOURCE_UPLOAD,
    files:              new Map(),
    symbolMap:          new Map(), // Map<symbolName, {file, lineStart, lineEnd, kind}[]>
    queryIndex:         new Map(), // Map<token, {file, lineStart, lineEnd, snippet, kind, kindBoost}[]>
    fileAccessMap:      new Map(), // Map<path, epochMs> — recency signal for hybrid ranking
    fileCountTotal:     0,
    fileCountCompleted: 0,
    fileCountFailed:    0,
    fileCountPending:   0,
    status:             '',
    indexedAt:          null,
};

export const workspaceMetadataStore = createWorkspaceMetadataStore();
export const brotliCompress         = promisify(zlib.brotliCompress);
export const brotliDecompress       = promisify(zlib.brotliDecompress);
export const execFileAsync          = promisify(execFile);

export {
    clampBrotliQuality,
    parseIntegerInRange,
    toSafePath,
};
