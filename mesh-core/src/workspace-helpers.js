/**
 * MESH Worker — Workspace helper functions.
 * State persistence, path utilities, local filesystem ops, git helpers,
 * envelope parsing, and pre-indexing normalization.
 * Imports shared state and constants from ./mesh-state.js.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { StringDecoder } from 'string_decoder';
import { createRequire } from 'module';
import { compressMeshPayload, decompressMeshPayload } from './MeshServer.js';
import compressionCore from './compression-core.cjs';
import compressionUtils from './compression-utils.cjs';
import {
    workspaceState,
    workspaceMetadataStore,
    brotliCompress,
    brotliDecompress,
    execFileAsync,
    WORKSPACE_CACHE_FILE,
    WORKSPACE_BROTLI_QUALITY,
    WORKSPACE_INITIAL_BROTLI_QUALITY,
    WORKSPACE_SOURCE_UPLOAD,
    WORKSPACE_SOURCE_LOCAL_PATH,
    WORKSPACE_PERF_LOG_ENABLED,
    LOCAL_WORKSPACE_SKIP_EXTENSIONS,
    LOCAL_WORKSPACE_SKIP_DIRS,
    LOCAL_WORKSPACE_MAX_FILE_CHARS,
    BLOB_WORKSPACE_SOURCE_NOTE,
    toSafePath,
} from './mesh-state.js';

const {
    LEGACY_WORKSPACE_ENCODING,
    TRANSPORT_ENVELOPE_VERSION,
    WORKSPACE_RECORD_VERSION,
    buildWorkspaceFileRecord,
    buildWorkspaceFileView,
    decodeRawStorage,
    ensureWorkspaceFileRecord,
    recoverWorkspaceFileRecord,
    resolveWorkspacePath,
    serializeWorkspaceFileRecord,
    suggestRecoverySpanIds,
} = compressionCore;
const { mapWithConcurrency } = compressionUtils;

function safeReadJsonFile(filePath, fallbackValue) {
    try {
        if (!fs.existsSync(filePath)) return fallbackValue;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) return fallbackValue;
        return JSON.parse(raw);
    } catch {
        return fallbackValue;
    }
}

function safeWriteJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch {
        return false;
    }
}

function createWorkspacePerfTracker(scope, meta = {}) {
    const startedAt = Date.now();
    const marks = [];
    return {
        mark(label, extra = {}) {
            marks.push({ label, at: Date.now(), ...extra });
        },
        flush(extra = {}) {
            if (!WORKSPACE_PERF_LOG_ENABLED) return;
            const totalMs = Date.now() - startedAt;
            const detail = marks.map((mark, index) => {
                const previousAt = index > 0 ? marks[index - 1].at : startedAt;
                return `${mark.label}:${mark.at - previousAt}ms`;
            }).join(' | ');
            console.log(`[mesh-perf] ${scope} total=${totalMs}ms meta=${JSON.stringify({ ...meta, ...extra })}${detail ? ` steps=${detail}` : ''}`);
        },
    };
}

function isWorkspaceIndexablePath(pathInput = '') {
    const normalized = toSafePath(pathInput);
    if (!normalized) return false;
    if (LOCAL_WORKSPACE_SKIP_DIRS.test(normalized)) return false;
    if (LOCAL_WORKSPACE_SKIP_EXTENSIONS.test(normalized)) return false;
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|cargo\.lock)$/i.test(normalized)) return false;
    return true;
}

function normalizeWorkspaceSourceKind(rawValue) {
    return String(rawValue || '').trim().toLowerCase() === WORKSPACE_SOURCE_LOCAL_PATH
        ? WORKSPACE_SOURCE_LOCAL_PATH
        : WORKSPACE_SOURCE_UPLOAD;
}

function serializeWorkspaceState() {
    return {
        folderName: workspaceState.folderName,
        rootPath: workspaceState.rootPath,
        workspaceId: workspaceState.workspaceId,
        sessionId: workspaceState.sessionId,
        sourceKind: normalizeWorkspaceSourceKind(workspaceState.sourceKind),
        fileCountTotal: workspaceState.fileCountTotal,
        fileCountCompleted: workspaceState.fileCountCompleted,
        fileCountFailed: workspaceState.fileCountFailed,
        fileCountPending: workspaceState.fileCountPending,
        status: workspaceState.status,
        indexedAt: workspaceState.indexedAt,
        files: [...workspaceState.files.values()].map((meta) => serializeWorkspaceFileRecord(meta)),
    };
}

function persistWorkspaceState() {
    safeWriteJsonFile(WORKSPACE_CACHE_FILE, serializeWorkspaceState());
}

function restoreWorkspaceState() {
    const persisted = safeReadJsonFile(WORKSPACE_CACHE_FILE, null);
    if (!persisted || typeof persisted !== 'object') return;

    const next = new Map();
    const files = Array.isArray(persisted.files) ? persisted.files : [];
    for (const file of files) {
        const filePath = toSafePath(file?.path);
        if (!filePath) continue;
        next.set(filePath, {
            ...file,
            path: filePath,
        });
    }

    workspaceState.folderName = String(persisted.folderName || '') || null;
    workspaceState.rootPath = String(persisted.rootPath || '') || null;
    workspaceState.workspaceId = String(persisted.workspaceId || '') || null;
    workspaceState.sessionId = String(persisted.sessionId || '') || null;
    workspaceState.sourceKind = normalizeWorkspaceSourceKind(persisted.sourceKind);
    workspaceState.fileCountTotal = Number(persisted.fileCountTotal || next.size || 0);
    workspaceState.fileCountCompleted = Number(persisted.fileCountCompleted || next.size || 0);
    workspaceState.fileCountFailed = Number(persisted.fileCountFailed || 0);
    workspaceState.fileCountPending = Number(persisted.fileCountPending || 0);
    workspaceState.status = String(persisted.status || '') || null;
    workspaceState.indexedAt = String(persisted.indexedAt || '') || null;
    workspaceState.files = next;
}

function workspaceRecordIndexed(meta) {
    return Boolean(
        meta?.capsuleCache
        && meta?.transportEnvelope
        && (meta?.rawStorage || meta?.compressedBase64),
    );
}

async function ensureWorkspaceMeta(meta, pathHint = '') {
    return ensureWorkspaceFileRecord(meta, {
        path: pathHint || meta?.path || '',
        legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
    });
}

function buildWorkspaceFileListingEntry(meta) {
    const stats = meta?.compressionStats || {};
    const entry = {
        path: meta.path,
        originalSize: Number(meta.originalSize || 0),
        compressedSize: Number(meta.compressedSize || 0),
        indexed: workspaceRecordIndexed(meta),
        kind: meta?.kind || (workspaceRecordIndexed(meta) ? 'source' : 'pending'),
        fileType: String(meta?.fileType || ''),
        parserFamily: String(meta?.parserFamily || ''),
        parseOk: Boolean(meta?.parseOk),
        capsuleMode: String(meta?.capsuleMode || ''),
        status: String(meta?.status || (workspaceRecordIndexed(meta) ? 'completed' : 'pending')),
        error: String(meta?.error || ''),
        compressionRatio: Number(stats.compressionRatio || 0),
        capsuleBytes: Number(stats.capsuleBytes || 0),
        rawBytes: Number(stats.rawBytes || meta?.originalSize || 0),
        transportBytes: Number(stats.transportBytes || 0),
    };
    return entry;
}

function workspaceStateSummary() {
    return {
        folderName: workspaceState.folderName,
        rootPath: workspaceState.rootPath || '',
        workspaceId: workspaceState.workspaceId || '',
        sessionId: workspaceState.sessionId || '',
        sourceKind: normalizeWorkspaceSourceKind(workspaceState.sourceKind),
        fileCountTotal: Number(workspaceState.fileCountTotal || workspaceState.files.size || 0),
        fileCountCompleted: Number(workspaceState.fileCountCompleted || 0),
        fileCountFailed: Number(workspaceState.fileCountFailed || 0),
        fileCountPending: Number(workspaceState.fileCountPending || 0),
        status: String(workspaceState.status || ''),
        indexedAt: workspaceState.indexedAt,
    };
}

function clearWorkspaceState() {
    workspaceState.folderName = null;
    workspaceState.rootPath = null;
    workspaceState.workspaceId = null;
    workspaceState.sessionId = null;
    workspaceState.sourceKind = WORKSPACE_SOURCE_UPLOAD;
    workspaceState.files = new Map();
    workspaceState.fileCountTotal = 0;
    workspaceState.fileCountCompleted = 0;
    workspaceState.fileCountFailed = 0;
    workspaceState.fileCountPending = 0;
    workspaceState.status = '';
    workspaceState.indexedAt = null;
}


function basename(filePath) {
    const normalized = toSafePath(filePath);
    const parts = normalized.split('/');
    return parts[parts.length - 1] || normalized;
}

function ensureWorkspaceOwnedPath(pathInput, workspaceFolderName) {
    const requested = toSafePath(pathInput);
    if (!requested) return '';

    const root = toSafePath(workspaceFolderName);
    if (!root) return requested;
    if (requested === root || requested.startsWith(`${root}/`)) return requested;
    return `${root}/${requested}`;
}

function isLocalPathWorkspace() {
    return normalizeWorkspaceSourceKind(workspaceState.sourceKind) === WORKSPACE_SOURCE_LOCAL_PATH
        && Boolean(workspaceState.rootPath);
}

function isUploadWorkspace() {
    return normalizeWorkspaceSourceKind(workspaceState.sourceKind) === WORKSPACE_SOURCE_UPLOAD
        && Boolean(workspaceState.workspaceId);
}

function selectedWorkspaceId(data = {}) {
    return String(data?.workspaceId || workspaceState.workspaceId || '').trim();
}

async function syncUploadWorkspaceSummary(workspaceId, fallback = {}) {
    if (!workspaceMetadataStore.enabled || !workspaceId) return null;
    const summary = await workspaceMetadataStore.getWorkspaceSummary(workspaceId);
    if (!summary) return null;
    workspaceState.folderName = String(summary.folderName || fallback.folderName || workspaceState.folderName || 'workspace') || 'workspace';
    workspaceState.rootPath = '';
    workspaceState.workspaceId = String(summary.workspaceId || workspaceId);
    workspaceState.sessionId = String(summary.sessionId || fallback.sessionId || workspaceState.sessionId || '');
    workspaceState.sourceKind = WORKSPACE_SOURCE_UPLOAD;
    workspaceState.fileCountTotal = Number(summary.fileCountTotal || 0);
    workspaceState.fileCountCompleted = Number(summary.fileCountCompleted || 0);
    workspaceState.fileCountFailed = Number(summary.fileCountFailed || 0);
    workspaceState.fileCountPending = Number(summary.fileCountPending || 0);
    workspaceState.status = String(summary.status || '');
    workspaceState.indexedAt = String(summary.indexedAt || summary.updatedAt || '') || null;
    workspaceState.files = new Map();
    persistWorkspaceState();
    return summary;
}

function toWorkspacePath(folderName, relativePath = '') {
    const root = toSafePath(folderName);
    const relative = toSafePath(relativePath);
    if (!root) return relative;
    return relative ? `${root}/${relative}` : root;
}

function toWorkspaceRelativePath(pathInput, folderName = workspaceState.folderName) {
    const requested = toSafePath(pathInput);
    if (!requested) return '';

    const root = toSafePath(folderName);
    if (!root) return requested;
    if (requested === root) return '';
    if (requested.startsWith(`${root}/`)) return requested.slice(root.length + 1);
    return requested;
}


// Storage is no longer backed by Azure Blob — all blob functions throw to prevent silent data loss.
function normalizeWorkspaceBlobStorage() { return null; }
function buildWorkspaceBlobAccessUrl() { throw new Error('Blob storage not supported.'); }
function getWorkspaceBlobClient() { throw new Error('Blob storage not supported.'); }
async function stageWorkspaceBlobForIndexing() { throw new Error('Blob storage not supported.'); }
async function readWorkspaceBlobText() { throw new Error('Blob storage not supported.'); }
async function writeWorkspaceBlobText() { throw new Error('Blob storage not supported.'); }
async function copyWorkspaceBlob() { throw new Error('Blob storage not supported.'); }
async function deleteWorkspaceBlob() { throw new Error('Blob storage not supported.'); }
function workspaceUploadBlobStorageForPath() { return null; }
async function packBlobBackedWorkspaceRecord() { throw new Error('Blob storage not supported.'); }

async function withTemporaryWorkspaceFile(prefix, callback) {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    const tempFilePath = path.join(tempDir, 'workspace-source.tmp');
    try {
        return await callback(tempFilePath);
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

function appendDecodedChunk(state, chunk) {
    if (state.binary) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buffer.length) return;

    state.byteLength += buffer.length;
    if (buffer.includes(0)) {
        state.binary = true;
        state.truncated = false;
        state.decoder.end();
        return;
    }

    if (state.done) return;

    const decoded = state.decoder.write(buffer);
    if (!decoded) return;

    const remaining = LOCAL_WORKSPACE_MAX_FILE_CHARS - state.textLength;
    if (remaining <= 0) {
        state.done = true;
        state.truncated = true;
        return;
    }

    if (decoded.length <= remaining) {
        state.parts.push(decoded);
        state.textLength += decoded.length;
        return;
    }

    state.parts.push(decoded.slice(0, remaining));
    state.textLength += remaining;
    state.done = true;
    state.truncated = true;
}

async function extractIndexableTextFromStream(stream) {
    const decoderState = {
        decoder: new StringDecoder('utf8'),
        parts: [],
        textLength: 0,
        byteLength: 0,
        truncated: false,
        binary: false,
        done: false,
    };

    for await (const chunk of stream) {
        appendDecodedChunk(decoderState, chunk);
    }

    if (!decoderState.binary && !decoderState.done) {
        const tail = decoderState.decoder.end();
        if (tail) appendDecodedChunk(decoderState, Buffer.from(tail, 'utf8'));
    }

    if (decoderState.binary) {
        return {
            content: '[binary or unreadable]',
            byteLength: decoderState.byteLength,
            truncated: false,
            binary: true,
        };
    }

    let content = decoderState.parts.join('');
    if (decoderState.truncated) {
        content = `${content}\n\n${BLOB_WORKSPACE_SOURCE_NOTE}`;
    }

    return {
        content,
        byteLength: decoderState.byteLength,
        truncated: decoderState.truncated,
        binary: false,
    };
}

function normalizeAbsoluteRootPath(rootPath) {
    const input = String(rootPath || '').trim();
    if (!input) return '';
    return path.resolve(input);
}

function resolveLocalWorkspaceAbsolutePath(pathInput) {
    if (!isLocalPathWorkspace()) {
        throw new Error('No local workspace root configured.');
    }

    const requested = ensureWorkspaceOwnedPath(pathInput, workspaceState.folderName);
    if (!requested || requested.endsWith('/')) {
        throw new Error('Invalid file path');
    }

    const relativePath = toWorkspaceRelativePath(requested, workspaceState.folderName);
    if (!relativePath) {
        throw new Error('Invalid file path');
    }

    const absolutePath = path.resolve(workspaceState.rootPath, relativePath);
    if (absolutePath !== workspaceState.rootPath && !absolutePath.startsWith(`${workspaceState.rootPath}${path.sep}`)) {
        throw new Error('Path escapes workspace root.');
    }

    return { requested, relativePath, absolutePath };
}

function gitPathFromWorkspacePath(pathInput) {
    const relativePath = toWorkspaceRelativePath(pathInput, workspaceState.folderName);
    return toSafePath(relativePath);
}

function workspacePathFromGitPath(pathInput) {
    return toWorkspacePath(workspaceState.folderName || '', pathInput);
}

async function readLocalWorkspaceFileText(absolutePath) {
    try {
        const buffer = await fs.promises.readFile(absolutePath);
        if (buffer.includes(0)) return '[binary or unreadable]';
        let text = buffer.toString('utf8');
        if (text.length > LOCAL_WORKSPACE_MAX_FILE_CHARS) {
            text = `${text.slice(0, LOCAL_WORKSPACE_MAX_FILE_CHARS)}\n\n[mesh note] File truncated during indexing because it exceeded ${LOCAL_WORKSPACE_MAX_FILE_CHARS.toLocaleString()} characters.`;
        }
        return text;
    } catch {
        return '[binary or unreadable]';
    }
}

async function scanLocalWorkspaceFiles(rootPath, folderName) {
    const pending = [{ absolutePath: rootPath, relativePath: '' }];
    const discovered = [];

    while (pending.length) {
        const current = pending.pop();
        let dirents = [];
        try {
            dirents = await fs.promises.readdir(current.absolutePath, { withFileTypes: true });
        } catch {
            continue;
        }

        dirents.sort((a, b) => a.name.localeCompare(b.name));

        for (const dirent of dirents) {
            const relativePath = toSafePath(current.relativePath ? `${current.relativePath}/${dirent.name}` : dirent.name);
            if (!relativePath) continue;

            if (dirent.isDirectory()) {
                if (LOCAL_WORKSPACE_SKIP_DIRS.test(relativePath)) continue;
                pending.push({
                    absolutePath: path.join(current.absolutePath, dirent.name),
                    relativePath,
                });
                continue;
            }

            if (!dirent.isFile()) continue;
            if (LOCAL_WORKSPACE_SKIP_DIRS.test(relativePath) || LOCAL_WORKSPACE_SKIP_EXTENSIONS.test(relativePath)) continue;

            discovered.push({
                workspacePath: toWorkspacePath(folderName, relativePath),
                absolutePath: path.join(current.absolutePath, dirent.name),
            });
        }
    }

    return discovered;
}

async function packWorkspaceContentRecord(workspacePath, content, options = {}) {
    return buildWorkspaceFileRecord(workspacePath, content, {
        legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
        initialBrotliQuality: WORKSPACE_INITIAL_BROTLI_QUALITY,
        recordMode: options.recordMode || 'full',
    });
}

async function loadWorkspaceRecordText(meta, requestedPath = '') {
    const record = await ensureWorkspaceMeta(meta, requestedPath || meta?.path || '');
    return decodeRawStorage(record.rawStorage);
}

async function writeLocalWorkspaceFileToDisk(pathInput, content, options = {}) {
    const { requested, absolutePath } = resolveLocalWorkspaceAbsolutePath(pathInput);
    const overwrite = options.overwrite === true;

    if (!overwrite) {
        try {
            await fs.promises.access(absolutePath, fs.constants.F_OK);
            return { ok: false, error: 'File already exists' };
        } catch {
            // File does not exist yet.
        }
    }

    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, content, 'utf8');

    const packed = await packWorkspaceContentRecord(requested, content);
    workspaceState.files.set(requested, {
        path: requested,
        ...packed,
        kind: 'source',
    });
    workspaceState.indexedAt = new Date().toISOString();
    persistWorkspaceState();

    return {
        ok: true,
        path: requested,
        originalSize: Number(packed.originalSize || 0),
        compressedSize: Number(packed.compressedSize || 0),
        capsuleBytes: Number(packed.compressionStats?.capsuleBytes || 0),
        transportBytes: Number(packed.compressionStats?.transportBytes || 0),
        updatedAt: workspaceState.indexedAt,
    };
}

function normalizeGitError(error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    const message = stderr || stdout || String(error?.message || 'Git command failed');
    if (/not a git repository/i.test(message)) return 'Not a git repository.';
    if (/spawn git/i.test(message) || /enoent/i.test(message)) return 'Git is not available on the server.';
    return message;
}

function getGitCwd() {
    if (!isLocalPathWorkspace()) {
        throw new Error('No local workspace root configured.');
    }
    return workspaceState.rootPath;
}

async function runGit(args, cwd = getGitCwd()) {
    try {
        const { stdout, stderr } = await execFileAsync('git', args, {
            cwd,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30_000,
        });
        return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
        throw new Error(normalizeGitError(error));
    }
}

function sortedWorkspacePaths() {
    return [...workspaceState.files.keys()].sort((a, b) => a.localeCompare(b));
}

async function parseMeshEnvelope(req) {
    if (req.headers['x-mesh-encoding'] === 'brotli' && Buffer.isBuffer(req.body)) {
        const unpacked = await decompressMeshPayload(req.body);
        return JSON.parse(unpacked);
    }

    if (typeof req.body === 'object' && req.body !== null) {
        return req.body;
    }

    throw new Error('Unsupported payload format');
}

async function sendCompressedJson(res, payload, statusCode = 200) {
    const responseText = JSON.stringify(payload);
    const compressed = await compressMeshPayload(responseText);

    res.status(statusCode).set({
        'Content-Type': 'application/octet-stream',
        'X-Mesh-Encoding': 'brotli',
    });

    res.end(compressed.buffer);
}

async function compressWorkspaceSource(rawText) {
    const normalized = typeof rawText === 'string' ? rawText : String(rawText || '');
    const buffer = await brotliCompress(Buffer.from(normalized, 'utf8'), {
        params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_QUALITY]: WORKSPACE_BROTLI_QUALITY,
        },
    });

    return {
        buffer,
        originalSize: Buffer.byteLength(normalized, 'utf8'),
        compressedSize: buffer.length,
    };
}

async function decompressWorkspaceSource(base64Buffer) {
    const decompressed = await brotliDecompress(Buffer.from(base64Buffer, 'base64'));
    return decompressed.toString('utf8');
}

function normalizeIncomingWorkspacePreindexedFile(candidate, filePath) {
    if (!candidate || typeof candidate !== 'object') return null;
    const normalized = {
        ...candidate,
        path: filePath,
    };

    if (!normalized.transportEnvelope && normalized.envelopeVersion && Array.isArray(normalized.chunks)) {
        normalized.transportEnvelope = {
            envelopeVersion: normalized.envelopeVersion,
            contentEncoding: normalized.contentEncoding,
            rawBytes: normalized.rawBytes,
            compressedBytes: normalized.compressedBytes,
            chunkSize: normalized.chunkSize,
            chunkCount: normalized.chunkCount,
            spanCount: normalized.spanCount,
            digest: normalized.digest,
            chunkIndex: Array.isArray(normalized.chunkIndex) ? normalized.chunkIndex : [],
            spanIndex: normalized.spanIndex && typeof normalized.spanIndex === 'object' ? normalized.spanIndex : {},
            chunks: normalized.chunks,
            manifestText: typeof normalized.manifestText === 'string' ? normalized.manifestText : '',
        };
    }

    return normalized;
}


export {
    safeReadJsonFile,
    safeWriteJsonFile,
    normalizeWorkspaceSourceKind,
    serializeWorkspaceState,
    persistWorkspaceState,
    restoreWorkspaceState,
    workspaceRecordIndexed,
    ensureWorkspaceMeta,
    buildWorkspaceFileListingEntry,
    workspaceStateSummary,
    clearWorkspaceState,
    toSafePath,
    basename,
    ensureWorkspaceOwnedPath,
    createWorkspacePerfTracker,
    mapWithConcurrency,
    isWorkspaceIndexablePath,
    isLocalPathWorkspace,
    isUploadWorkspace,
    selectedWorkspaceId,
    syncUploadWorkspaceSummary,
    toWorkspacePath,
    toWorkspaceRelativePath,
    normalizeWorkspaceBlobStorage,
    buildWorkspaceBlobAccessUrl,
    getWorkspaceBlobClient,
    withTemporaryWorkspaceFile,
    appendDecodedChunk,
    extractIndexableTextFromStream,
    stageWorkspaceBlobForIndexing,
    readWorkspaceBlobText,
    writeWorkspaceBlobText,
    copyWorkspaceBlob,
    deleteWorkspaceBlob,
    normalizeAbsoluteRootPath,
    resolveLocalWorkspaceAbsolutePath,
    gitPathFromWorkspacePath,
    workspacePathFromGitPath,
    readLocalWorkspaceFileText,
    scanLocalWorkspaceFiles,
    packWorkspaceContentRecord,
    workspaceUploadBlobStorageForPath,
    packBlobBackedWorkspaceRecord,
    loadWorkspaceRecordText,
    writeLocalWorkspaceFileToDisk,
    normalizeGitError,
    getGitCwd,
    runGit,
    sortedWorkspacePaths,
    parseMeshEnvelope,
    sendCompressedJson,
    compressWorkspaceSource,
    decompressWorkspaceSource,
    normalizeIncomingWorkspacePreindexedFile,
};
