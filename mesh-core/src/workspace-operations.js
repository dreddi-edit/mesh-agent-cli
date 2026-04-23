/**
 * MESH Worker — Workspace operations (indexing, select, file I/O, search, git, chat).
 * Extracted from server.js. Imports shared state from mesh-state.js and
 * helper functions from workspace-helpers.js.
 */

import fs from 'fs';
import path from 'path';
import * as assistantCoreNamespace from '../../assistant-core.js';
import compressionCore from './compression-core.cjs';
import {
    workspaceState,
    workspaceMetadataStore,
    brotliCompress,
    brotliDecompress,
    execFileAsync,
    WORKSPACE_BROTLI_QUALITY,
    WORKSPACE_INITIAL_BROTLI_QUALITY,
    WORKSPACE_INDEX_PARALLELISM,
    WORKSPACE_READ_CONCURRENCY,
    WORKSPACE_BUILD_CONCURRENCY,
    WORKSPACE_ENRICH_CONCURRENCY,
    WORKSPACE_PERF_LOG_ENABLED,
    WORKSPACE_SOURCE_UPLOAD,
    WORKSPACE_SOURCE_LOCAL_PATH,
    LOCAL_WORKSPACE_SKIP_EXTENSIONS,
    LOCAL_WORKSPACE_SKIP_DIRS,
    LOCAL_WORKSPACE_MAX_FILE_CHARS,
    BLOB_WORKSPACE_SOURCE_NOTE,
    parseIntegerInRange,
    toSafePath,
} from './mesh-state.js';
import {
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
} from './workspace-helpers.js';

const assistantCore = assistantCoreNamespace.default && typeof assistantCoreNamespace.default === 'object'
    ? assistantCoreNamespace.default
    : assistantCoreNamespace;

const {
    extractQueryExtensionHints,
    extractSearchTokens,
    pathHasExtensionHint,
    rankWorkspacePathsForQuery,
    scorePathForQuery,
    toSafePath: sharedSafePath,
} = assistantCore;
const {
    LEGACY_WORKSPACE_ENCODING,
    TRANSPORT_ENVELOPE_VERSION,
    WORKSPACE_RECORD_VERSION,
    MAX_CALL_SITES_PER_FILE,
    MAX_QUERY_TOKENS_PER_FILE,
    buildQueryIndexEntries,
    buildWorkspaceFileRecord,
    buildWorkspaceFileView,
    decodeRawStorage,
    ensureWorkspaceFileRecord,
    recoverWorkspaceFileRecord,
    resolveWorkspacePath,
    serializeWorkspaceFileRecord,
    suggestRecoverySpanIds,
} = compressionCore;

const MAX_QUERY_SNIPPETS = (() => {
    const configured = Number(process.env.MESH_CAPSULE_MAX_QUERY_SNIPPETS);
    const fallback = 5;
    const normalized = Number.isFinite(configured) ? Math.trunc(configured) : fallback;
    return Math.max(1, Math.min(normalized, 20));
})();

async function compressWorkspaceChunkFiles(incomingFiles, options = {}) {
    const recordMode = String(options.recordMode || 'initial').trim().toLowerCase() === 'full' ? 'full' : 'initial';
    const normalized = [];
    for (const file of incomingFiles) {
        const filePath = toSafePath(file?.path || file?.name);
        if (!filePath || !isWorkspaceIndexablePath(filePath)) continue;
        const preindexed = normalizeIncomingWorkspacePreindexedFile(file, filePath);
        normalized.push({
            filePath,
            content: typeof file?.content === 'string' ? file.content : '',
            originalSize: Number(file?.sizeBytes ?? file?.size ?? preindexed?.originalSize ?? 0),
            preindexed,
        });
    }

    const workspaceFilePaths = Array.from(new Set([
        ...Array.from(workspaceState.files.keys()),
        ...normalized.map((entry) => entry.filePath),
    ]));

    return mapWithConcurrency(normalized, WORKSPACE_BUILD_CONCURRENCY, async (entry) => ({
        filePath: entry.filePath,
        packed: (entry.preindexed?.rawStorage || entry.preindexed?.transportEnvelope || entry.preindexed?.capsuleCache || entry.preindexed?.compressedBase64)
            ? await ensureWorkspaceFileRecord({
                ...entry.preindexed,
                path: entry.filePath,
            }, {
                path: entry.filePath,
                legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
            })
            : entry.preindexed?.storage
                ? await (async () => {
                    const indexed = await readWorkspaceBlobText(entry.preindexed.storage, entry.originalSize, {
                        readUrl: entry.preindexed.storageReadUrl,
                    });
                    return buildWorkspaceFileRecord(entry.filePath, indexed.content, {
                        legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
                        initialBrotliQuality: WORKSPACE_INITIAL_BROTLI_QUALITY,
                        originalSizeOverride: indexed.byteLength || entry.originalSize,
                        storage: entry.preindexed.storage,
                        truncated: indexed.truncated,
                        persistRawContent: false,
                        persistTransportChunks: false,
                        workspaceFilePaths,
                        recordMode,
                    });
                })()
                : await buildWorkspaceFileRecord(entry.filePath, entry.content, {
                    legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
                    initialBrotliQuality: WORKSPACE_INITIAL_BROTLI_QUALITY,
                    workspaceFilePaths,
                    recordMode,
                }),
    }));
}

async function openLocalWorkspace(data = {}) {
    const rootPath = normalizeAbsoluteRootPath(data?.rootPath);
    if (!rootPath) {
        return { ok: false, error: 'Workspace root path required.' };
    }

    let stats;
    try {
        stats = await fs.promises.stat(rootPath);
    } catch {
        return { ok: false, error: 'Workspace root not found.' };
    }

    if (!stats.isDirectory()) {
        return { ok: false, error: 'Workspace root must be a directory.' };
    }

    const folderName = String(data?.folderName || path.basename(rootPath) || 'workspace').trim() || 'workspace';
    const perf = createWorkspacePerfTracker('worker-open-local', { folderName });
    const files = (await scanLocalWorkspaceFiles(rootPath, folderName))
        .filter((entry) => isWorkspaceIndexablePath(entry.workspacePath));
    perf.mark('scan-complete', { files: files.length });
    const next = new Map();
    let originalBytes = 0;
    let compressedBytes = 0;
    let capsuleBytes = 0;
    let transportBytes = 0;
    const workspaceFilePaths = files.map((entry) => entry.workspacePath);
    const packedEntries = await mapWithConcurrency(files, WORKSPACE_BUILD_CONCURRENCY, async (entry) => {
        const content = await readLocalWorkspaceFileText(entry.absolutePath);
        const contentDigest = compressionCore.sha256Hex
            ? compressionCore.sha256Hex(Buffer.from(content, 'utf8'))
            : null;

        const existing = workspaceState.files.get(entry.workspacePath);
        if (existing
            && existing.rawStorage?.digest
            && contentDigest === existing.rawStorage.digest
            && existing.capsuleVariants) {
            return { ...entry, packed: existing };
        }

        const packed = await packWorkspaceContentRecord(entry.workspacePath, content, {
            recordMode: 'initial',
            workspaceFilePaths,
        });
        return { ...entry, packed };
    });
    perf.mark('initial-records-ready');

    const workspaceBudget = parseIntegerInRange(process.env.MESH_WORKSPACE_TOKEN_BUDGET, 2000, 64000, 8000);
    const budgetAllocated = compressionCore.allocateWorkspaceBudget
        ? compressionCore.allocateWorkspaceBudget(
            packedEntries.map((e) => e.packed),
            workspaceBudget,
        )
        : null;

    for (const [index, entry] of packedEntries.entries()) {
        const allocation = budgetAllocated ? budgetAllocated[index] : null;
        const recommendedTier = allocation && compressionCore.selectTierForBudget
            ? compressionCore.selectTierForBudget({ ...entry.packed, allocatedBudget: allocation.allocatedBudget })
            : undefined;
        next.set(entry.workspacePath, {
            path: entry.workspacePath,
            ...entry.packed,
            kind: 'source',
            ...(recommendedTier ? { recommendedTier } : {}),
            ...(allocation ? { allocatedBudget: allocation.allocatedBudget } : {}),
        });
        originalBytes += Number(entry.packed.originalSize || 0);
        compressedBytes += Number(entry.packed.compressedSize || 0);
        capsuleBytes += Number(entry.packed.compressionStats?.capsuleBytes || 0);
        transportBytes += Number(entry.packed.compressionStats?.transportBytes || 0);
    }

    workspaceState.folderName = folderName;
    workspaceState.rootPath = rootPath;
    workspaceState.workspaceId = '';
    workspaceState.sessionId = '';
    workspaceState.sourceKind = WORKSPACE_SOURCE_LOCAL_PATH;
    workspaceState.files = next;
    workspaceState.fileCountTotal = next.size;
    workspaceState.fileCountCompleted = next.size;
    workspaceState.fileCountPending = 0;
    workspaceState.fileCountFailed = 0;
    workspaceState.status = 'initial-ready';
    workspaceState.indexedAt = new Date().toISOString();
    persistWorkspaceState();

    provisionMeshFolder({ rootPath, folderName }).catch(() => {});
    enqueueWorkspaceEnrichment({ rootPath, folderName, workspaceId: workspaceState.workspaceId || '' });
    perf.flush({ discovered: files.length, indexed: next.size });

    return {
        ok: true,
        mode: 'mesh-worker',
        folderName,
        rootPath,
        sourceKind: WORKSPACE_SOURCE_LOCAL_PATH,
        append: false,
        manifestCount: 0,
        chunkFileCount: files.length,
        fileCount: next.size,
        indexedCount: next.size,
        pendingCount: 0,
        originalBytes,
        compressedBytes,
        capsuleBytes,
        transportBytes,
        ratio: compressedBytes > 0 ? Number((originalBytes / compressedBytes).toFixed(2)) : null,
    };
}

// ─── Background Indexer ───────────────────────────────────────────────────────
// Queue-based: new files can be added while indexer is running.
// Automatically stops when workspace changes.
// Uses high parallelism: P3v3 x4 can handle 48 concurrent blob reads.
const BG_INDEX_PARALLELISM = parseIntegerInRange(process.env.MESH_BG_INDEX_PARALLELISM, 48, 4, 128);

const indexerQueues = new Map(); // workspaceId → { queue: Set, running: bool, folderName }

function enqueueForIndexing(workspaceId, folderName, files) {
    if (!workspaceMetadataStore.enabled) return;
    let state = indexerQueues.get(workspaceId);
    if (!state) {
        state = { queue: new Map(), running: false, folderName };
        indexerQueues.set(workspaceId, state);
    }
    // Add files to queue (Map deduplicates by path)
    for (const f of files) {
        if (f.path && f.storage) state.queue.set(f.path, f);
    }
    if (!state.running) {
        state.running = true;
        setImmediate(() => runIndexerForWorkspace(workspaceId));
    }
}

async function runIndexerForWorkspace(workspaceId) {
    const state = indexerQueues.get(workspaceId);
    if (!state) return;
    const { folderName } = state;
    const perf = createWorkspacePerfTracker('worker-cloud-index', { workspaceId, folderName });
    let totalCompleted = 0;
    let totalFailed = 0;

    console.log(`[indexer] start workspaceId=${workspaceId} folderName=${folderName} queued=${state.queue.size}`);
    try {
        while (state.queue.size > 0) {
            // Stop if workspace changed (user opened different folder)
            if (workspaceState.workspaceId && workspaceState.workspaceId !== workspaceId) {
                console.log(`[indexer] workspace changed, aborting ${workspaceId}`);
                break;
            }

            // Optimization: Fetch all known paths ONCE for this batch
            // This includes already indexed files PLUS all files currently in the queue
            const allMeta = await workspaceMetadataStore.listWorkspaceFiles(workspaceId);
            const workspaceFilePaths = [
                ...allMeta.map(m => m.path),
                ...Array.from(state.queue.keys())
            ];

            // Take a batch from the queue
            const batch = [];
            for (const [path, entry] of state.queue) {
                batch.push(entry);
                state.queue.delete(path);
                if (batch.length >= BG_INDEX_PARALLELISM) break;
            }

            let batchCompleted = 0;
            let batchFailed = 0;

            await mapWithConcurrency(batch, WORKSPACE_BUILD_CONCURRENCY, async (fileEntry) => {
                const filePath = fileEntry.path;
                try {
                    // Skip if already completed
                    const existing = await workspaceMetadataStore.getWorkspaceFile(workspaceId, filePath);
                    if (existing && String(existing.status || '') === 'completed') {
                        batchCompleted++;
                        return;
                    }

                    const storage = fileEntry.storage;
                    const readResult = await readWorkspaceBlobText(storage, Number(fileEntry.sizeBytes || 0));
                    
                    const record = await buildWorkspaceFileRecord(filePath, readResult.content, {
                        legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
                        initialBrotliQuality: WORKSPACE_INITIAL_BROTLI_QUALITY,
                        originalSizeOverride: readResult.byteLength || Number(fileEntry.sizeBytes || 0),
                        storage,
                        truncated: readResult.truncated,
                        persistRawContent: false,
                        persistTransportChunks: false,
                        workspaceFilePaths,
                        recordMode: 'initial',
                    });
                    await workspaceMetadataStore.upsertWorkspaceFileRecord({
                        workspaceId,
                        folderName,
                        sourceKind: WORKSPACE_SOURCE_UPLOAD,
                        path: filePath,
                        status: 'completed',
                        record: {
                            ...record,
                            path: filePath,
                            originalSize: Number(record.originalSize || fileEntry.sizeBytes || 0),
                            compressedSize: Number(record.compressedSize || 0),
                            indexed: true,
                            kind: 'source',
                            storage,
                        },
                    });
                    batchCompleted++;
                } catch (err) {
                    batchFailed++;
                    console.error(`[indexer] failed ${filePath}: ${err?.message}`);
                    try {
                        await workspaceMetadataStore.markWorkspaceFileFailed({
                            workspaceId,
                            folderName,
                            sourceKind: WORKSPACE_SOURCE_UPLOAD,
                            path: filePath,
                            storage: fileEntry.storage || null,
                            originalSize: Number(fileEntry.sizeBytes || 0),
                            error: String(err?.message || 'indexing failed'),
                        });
                    } catch {}
                }
            });

            totalCompleted += batchCompleted;
            totalFailed += batchFailed;
            console.log(`[indexer] ${workspaceId} batch done: +${batchCompleted} ok +${batchFailed} fail | total ${totalCompleted}ok ${totalFailed}fail | queue remaining: ${state.queue.size}`);
        }
    } finally {
        state.running = false;
        // Clean up if queue is empty
        if (state.queue.size === 0) {
            indexerQueues.delete(workspaceId);
            // Final summary update
            try { await syncUploadWorkspaceSummary(workspaceId, { folderName }); } catch {}
            provisionMeshFolder({ workspaceId, folderName }).catch(() => {});
            enqueueWorkspaceEnrichment({ workspaceId, folderName });
        }
        perf.flush({ completed: totalCompleted, failed: totalFailed });
        console.log(`[indexer] done ${workspaceId}: ${totalCompleted} completed, ${totalFailed} failed`);
    }
}

async function selectWorkspaceFolder(data) {
    const shouldClear = Boolean(data?.clear);
    if (shouldClear) {
        clearWorkspaceState();
        persistWorkspaceState();

        return {
            ok: true,
            cleared: true,
            folderName: null,
            rootPath: '',
            sourceKind: WORKSPACE_SOURCE_UPLOAD,
            append: false,
            chunkFileCount: 0,
            fileCount: 0,
            originalBytes: 0,
            compressedBytes: 0,
            ratio: null,
        };
    }

    const folderName = String(data?.folderName || 'workspace');
    const workspaceId = String(data?.workspaceId || workspaceState.workspaceId || '').trim();
    const sessionId = String(data?.sessionId || workspaceState.sessionId || '').trim();
    const manifestEntries = Array.isArray(data?.manifest) ? data.manifest : [];
    const incomingFiles = Array.isArray(data?.files) ? data.files : [];
    const deletedPaths = Array.isArray(data?.deletedPaths) ? data.deletedPaths.map((entry) => toSafePath(entry)).filter(Boolean) : [];
    const syncMode = String(data?.mode || 'background').trim().toLowerCase() || 'background';
    const candidateEntries = (manifestEntries.length ? manifestEntries : incomingFiles)
        .filter((entry) => isWorkspaceIndexablePath(entry?.path || entry?.name || ''));
    const append = Boolean(data?.append);

    if (workspaceMetadataStore.enabled && workspaceId) {
        const seededFiles = candidateEntries.map((entry) => {
            const filePath = toSafePath(entry?.path || entry?.name);
            if (!filePath) return null;
            return {
                path: filePath,
                sizeBytes: Number(entry?.sizeBytes ?? entry?.size ?? 0),
                storage: normalizeWorkspaceBlobStorage(entry?.storage, filePath),
            };
        }).filter(Boolean);
        if (!append && deletedPaths.length === 0 && data?.complete === true) {
            await workspaceMetadataStore.reconcileWorkspace(workspaceId, seededFiles.map(f => f.path));
        }
        if (deletedPaths.length > 0) {
            await Promise.all(deletedPaths.map((filePath) => workspaceMetadataStore.deleteWorkspaceFileRecord(workspaceId, filePath, {
                folderName,
                rootPath: '',
                sourceKind: WORKSPACE_SOURCE_UPLOAD,
                sessionId,
            })));
        }

        await workspaceMetadataStore.seedWorkspaceManifest({
            workspaceId,
            folderName,
            rootPath: '',
            sourceKind: WORKSPACE_SOURCE_UPLOAD,
            sessionId,
            files: seededFiles,
        });
        const summary = await syncUploadWorkspaceSummary(workspaceId, {
            folderName,
            sessionId,
        });

        // Enqueue files for background indexing (non-blocking, queue-based)
        const filesToIndex = seededFiles.filter(f => f.storage && f.storage.blobPath);
        if (filesToIndex.length > 0) {
            enqueueForIndexing(workspaceId, folderName, filesToIndex);
        }

        return {
            ok: true,
            folderName: workspaceState.folderName || folderName,
            rootPath: '',
            workspaceId,
            sessionId,
            sourceKind: WORKSPACE_SOURCE_UPLOAD,
            status: String(summary?.status || workspaceState.status || 'processing'),
            append,
            mode: syncMode,
            manifestCount: candidateEntries.length,
            chunkFileCount: incomingFiles.length,
            fileCount: Number(summary?.fileCountTotal || workspaceState.fileCountTotal || seededFiles.length),
            indexedCount: Number(summary?.fileCountCompleted || workspaceState.fileCountCompleted || 0),
            pendingCount: Number(summary?.fileCountPending || workspaceState.fileCountPending || 0),
            failedCount: Number(summary?.fileCountFailed || workspaceState.fileCountFailed || 0),
            originalBytes: 0,
            compressedBytes: 0,
            capsuleBytes: 0,
            transportBytes: 0,
            ratio: null,
        };
    }

    const canAppend = append
        && workspaceState.folderName === folderName
        && normalizeWorkspaceSourceKind(workspaceState.sourceKind) === WORKSPACE_SOURCE_UPLOAD;

    let next;
    if (canAppend) {
        next = workspaceState.files;
    } else {
        next = new Map();
        workspaceState.folderName = folderName;
        workspaceState.rootPath = null;
        workspaceState.sourceKind = WORKSPACE_SOURCE_UPLOAD;
        workspaceState.files = next;
    }

    let originalBytes = 0;
    let compressedBytes = 0;
    let capsuleBytes = 0;
    let transportBytes = 0;
    for (const filePath of deletedPaths) {
        next.delete(filePath);
    }

    for (const entry of candidateEntries) {
        const filePath = toSafePath(entry?.path || entry?.name);
        if (!filePath || !isWorkspaceIndexablePath(filePath)) continue;

        const known = next.get(filePath);
        const declaredSize = Number(entry?.sizeBytes ?? entry?.size ?? known?.originalSize ?? 0);
        const normalizedSize = Number.isFinite(declaredSize) && declaredSize >= 0 ? declaredSize : Number(known?.originalSize || 0);
        const storage = normalizeWorkspaceBlobStorage(entry?.storage, filePath);

        if (workspaceRecordIndexed(known)) {
            next.set(filePath, {
                ...known,
                originalSize: normalizedSize,
                ...(storage ? { storage } : {}),
                kind: 'source',
            });
            continue;
        }

        next.set(filePath, {
            path: filePath,
            compressedBase64: '',
            originalSize: normalizedSize,
            compressedSize: 0,
            formatVersion: WORKSPACE_RECORD_VERSION,
            ...(storage ? {
                storage,
                rawStorage: {
                    encoding: 'external-azure-blob',
                    rawBytes: normalizedSize,
                },
            } : {}),
            kind: 'pending',
        });
    }

    const compressedEntries = await compressWorkspaceChunkFiles(incomingFiles, {
        recordMode: syncMode === 'single-file' ? 'full' : 'initial',
    });
    for (const entry of compressedEntries) {
        const packed = await ensureWorkspaceMeta(entry.packed, entry.filePath);
        originalBytes += Number(packed.originalSize || 0);
        compressedBytes += Number(packed.compressedSize || 0);
        capsuleBytes += Number(packed.compressionStats?.capsuleBytes || 0);
        transportBytes += Number(packed.compressionStats?.transportBytes || 0);
        next.set(entry.filePath, {
            ...packed,
            path: entry.filePath,
            kind: 'source',
        });
    }

    workspaceState.folderName = folderName;
    workspaceState.workspaceId = workspaceId;
    workspaceState.sessionId = sessionId;
    workspaceState.fileCountTotal = next.size;
    workspaceState.fileCountCompleted = [...next.values()].filter((meta) => workspaceRecordIndexed(meta)).length;
    workspaceState.fileCountPending = Math.max(0, next.size - workspaceState.fileCountCompleted);
    workspaceState.fileCountFailed = 0;
    workspaceState.status = syncMode === 'initial' ? 'initial-ready' : 'processing';
    workspaceState.indexedAt = new Date().toISOString();
    persistWorkspaceState();

    const indexedCount = workspaceState.fileCountCompleted;
    if (syncMode !== 'single-file') {
        enqueueWorkspaceEnrichment({ workspaceId, folderName });
    }

    return {
        ok: true,
        folderName,
        rootPath: '',
        sourceKind: WORKSPACE_SOURCE_UPLOAD,
        append: canAppend,
        mode: syncMode,
        manifestCount: candidateEntries.length,
        chunkFileCount: incomingFiles.length,
        fileCount: workspaceState.files.size,
        indexedCount,
        pendingCount: Math.max(0, workspaceState.files.size - indexedCount),
        originalBytes,
        compressedBytes,
        capsuleBytes,
        transportBytes,
        ratio: compressedBytes > 0 ? Number((originalBytes / compressedBytes).toFixed(2)) : null,
    };
}

async function listWorkspaceFiles(data = {}) {
    const workspaceId = selectedWorkspaceId(data);
    if (workspaceMetadataStore.enabled && workspaceId) {
        const summary = await syncUploadWorkspaceSummary(workspaceId, {
            folderName: String(data?.folderName || workspaceState.folderName || ''),
            sessionId: String(data?.sessionId || workspaceState.sessionId || ''),
        });
        const docs = await workspaceMetadataStore.listWorkspaceFiles(workspaceId);
        return {
            ok: true,
            ...workspaceStateSummary(),
            fileCount: Number(summary?.fileCountTotal || workspaceState.fileCountTotal || docs.length),
            files: docs.map((doc) => buildWorkspaceFileListingEntry(doc)),
        };
    }
    const summary = workspaceStateSummary();
    return {
        ok: true,
        ...summary,
        workspaceId: workspaceId || '',
        sessionId: workspaceId ? summary.sessionId : '',
        files: sortedWorkspacePaths().map((path) => buildWorkspaceFileListingEntry(workspaceState.files.get(path))),
    };
}

async function getWorkspaceGraph(data = {}) {
    const workspaceId = selectedWorkspaceId(data);
    const hasActiveWorkspace = Boolean(workspaceState.folderName || workspaceState.rootPath || workspaceState.workspaceId);
    let files = [];

    // Local-path workspaces always live in RAM — never route through the metadata store.
    // A synthetic or stale workspaceId sent by the frontend must not override the active
    // RAM workspace that was populated by openLocalWorkspace.
    if (isLocalPathWorkspace()) {
        files = [...workspaceState.files.values()];
    } else if (workspaceMetadataStore.enabled && workspaceId) {
        files = await workspaceMetadataStore.listWorkspaceFiles(workspaceId);
        // If the store returned nothing but RAM has data, fall back to RAM.
        // This covers: synthetic frontend workspaceId not matching the Cosmos partition
        // key, or indexing not yet complete when the graph is first requested.
        if (files.length === 0 && workspaceState.files.size > 0) {
            files = [...workspaceState.files.values()];
        }
    } else if (hasActiveWorkspace) {
        files = [...workspaceState.files.values()];
    }

    const nodes = [];
    const edges = [];
    const pathToId = new Map();

    // First pass: Create nodes
    for (const file of files) {
        const id = file.id || file.path;
        pathToId.set(file.path, id);
        nodes.push({
            id,
            path: file.path,
            name: basename(file.path),
            fileType: file.fileType || 'unknown',
            size: file.originalSize || 0,
        });
    }

    // Second pass: Create edges
    for (const file of files) {
        const fromId = pathToId.get(file.path);
        if (!fromId || !Array.isArray(file.dependencies)) continue;

        for (const depPath of file.dependencies) {
            const toId = pathToId.get(depPath);
            if (toId) {
                edges.push({ from: fromId, to: toId });
            }
        }
    }

    const symbolEdges = [];
    if (data?.includeSymbolEdges) {
        for (const file of files) {
            if (!Array.isArray(file.callSites)) continue;
            for (const site of file.callSites) {
                if (!site.resolvedFile) continue;
                const fromId = pathToId.get(file.path);
                const toId = pathToId.get(site.resolvedFile);
                if (!fromId || !toId || fromId === toId) continue;
                symbolEdges.push({
                    from: fromId,
                    fromFile: file.path,
                    fromLine: site.callerLine,
                    callee: site.calleeName,
                    to: toId,
                    toFile: site.resolvedFile,
                    toLine: site.resolvedLine,
                    kind: 'call',
                });
            }
        }
    }

    return {
        ok: true,
        workspaceId: workspaceId || '',
        // Tells the frontend whether a workspace is actually open, even when nodes is
        // empty (e.g. still indexing). Used to show the correct empty-state message.
        hasWorkspace: hasActiveWorkspace,
        nodes,
        edges,
        symbolEdges,
    };
}

function generateDependencyMapMarkdown(graph, folderName) {
    const { nodes, edges } = graph;
    if (!nodes || !nodes.length) {
        return [
            `# 🕸️ Dependency Map: ${folderName || 'Workspace'}`,
            '',
            '*No files with recognized dependencies found.*',
            '',
            '---',
            '*Generated by Mesh AI Dependency Analysis Engine.*',
        ].join('\n');
    }

    const nameById = new Map();
    for (const n of nodes) nameById.set(n.id, n.path || n.name);

    // imports: what each file imports
    const imports = new Map();
    // importedBy: reverse — who imports a given file
    const importedBy = new Map();

    for (const e of edges) {
        const fromPath = nameById.get(e.from) || e.from;
        const toPath = nameById.get(e.to) || e.to;
        if (!imports.has(fromPath)) imports.set(fromPath, []);
        imports.get(fromPath).push(toPath);
        if (!importedBy.has(toPath)) importedBy.set(toPath, []);
        importedBy.get(toPath).push(fromPath);
    }

    const lines = [
        `# 🕸️ Dependency Map: ${folderName || 'Workspace'}`,
        '',
        `> Auto-generated dependency analysis. ${nodes.length} files, ${edges.length} connections.`,
        '',
        '## Overview',
        '',
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Total Files | ${nodes.length} |`,
        `| Total Dependencies | ${edges.length} |`,
        `| Files with imports | ${imports.size} |`,
        `| Files imported by others | ${importedBy.size} |`,
        '',
    ];

    // Most connected files (hubs)
    const hubEntries = [...importedBy.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 10);

    if (hubEntries.length > 0) {
        lines.push('## 🔗 Most Connected (Hub Files)', '');
        lines.push('| File | Imported by |');
        lines.push('|------|------------|');
        for (const [filePath, dependents] of hubEntries) {
            lines.push(`| \`${filePath}\` | ${dependents.length} files |`);
        }
        lines.push('');
    }

    // Full dependency list
    const sortedFiles = [...imports.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (sortedFiles.length > 0) {
        lines.push('## 📦 File Dependencies', '');
        for (const [filePath, deps] of sortedFiles) {
            lines.push(`### \`${filePath}\``);
            lines.push('');
            lines.push('**Imports:**');
            for (const dep of deps.sort()) {
                lines.push(`- \`${dep}\``);
            }
            const rev = importedBy.get(filePath);
            if (rev && rev.length > 0) {
                lines.push('');
                lines.push('**Imported by:**');
                for (const r of rev.sort()) {
                    lines.push(`- \`${r}\``);
                }
            }
            lines.push('');
        }
    }

    return lines.join('\n');
}

let workspaceEnrichmentRunning = false;
const workspaceEnrichmentPending = [];

function enqueueWorkspaceEnrichment(ctx = {}) {
    const key = ctx.workspaceId || ctx.rootPath || 'local';
    const existing = workspaceEnrichmentPending.findIndex((job) => (job.workspaceId || job.rootPath || 'local') === key);
    if (existing !== -1) workspaceEnrichmentPending.splice(existing, 1);
    workspaceEnrichmentPending.push(ctx);
    if (!workspaceEnrichmentRunning) drainWorkspaceEnrichmentQueue();
}

async function drainWorkspaceEnrichmentQueue() {
    workspaceEnrichmentRunning = true;
    while (workspaceEnrichmentPending.length > 0) {
        const ctx = workspaceEnrichmentPending.shift();
        try {
            await enrichWorkspaceRecords(ctx);
        } catch (error) {
            console.error(`[mesh] Workspace enrichment failed: ${error?.message}`);
        }
    }
    workspaceEnrichmentRunning = false;
}

async function enrichWorkspaceRecords(ctx = {}) {
    const { workspaceId = '', folderName = workspaceState.folderName || 'workspace', rootPath = workspaceState.rootPath || '' } = ctx;
    const perf = createWorkspacePerfTracker('worker-enrich', { workspaceId, folderName });
    let files = [];
    if (workspaceMetadataStore.enabled && workspaceId) {
        files = await workspaceMetadataStore.listWorkspaceFiles(workspaceId);
    } else if (workspaceState.folderName || workspaceState.workspaceId) {
        files = [...workspaceState.files.values()];
    }

    const indexableFiles = files.filter((meta) => {
        const storageProvider = String(meta?.storage?.provider || '');
        return meta?.path
            && isWorkspaceIndexablePath(meta.path)
            && storageProvider !== 'virtual';
    });
    const workspaceFilePaths = indexableFiles.map((meta) => meta.path);
    const candidates = indexableFiles.filter((meta) => String(meta?.recordMode || '').toLowerCase() !== 'full');
    if (!candidates.length) {
        perf.flush({ enriched: 0, skipped: indexableFiles.length });
        return;
    }

    await mapWithConcurrency(candidates, WORKSPACE_ENRICH_CONCURRENCY, async (meta) => {
        let content = '';
        let truncated = false;
        let originalSize = Number(meta?.originalSize || 0);
        if (meta?.storage?.provider === 'azure-blob') {
            const blob = await readWorkspaceBlobText(meta.storage, originalSize);
            content = blob.content;
            truncated = Boolean(blob.truncated);
            originalSize = Number(blob.byteLength || originalSize);
        } else if (rootPath) {
            const relativePath = toWorkspaceRelativePath(meta.path, folderName);
            const absolutePath = path.resolve(rootPath, relativePath);
            content = await readLocalWorkspaceFileText(absolutePath);
            originalSize = Buffer.byteLength(String(content || ''), 'utf8');
        } else {
            content = decodeRawStorage(meta.rawStorage);
            originalSize = Number(meta?.originalSize || Buffer.byteLength(String(content || ''), 'utf8'));
        }

        const record = await buildWorkspaceFileRecord(meta.path, content, {
            legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
            initialBrotliQuality: WORKSPACE_INITIAL_BROTLI_QUALITY,
            originalSizeOverride: originalSize,
            storage: meta?.storage?.provider === 'azure-blob' ? meta.storage : undefined,
            truncated,
            persistRawContent: meta?.storage?.provider === 'azure-blob' ? false : undefined,
            persistTransportChunks: meta?.storage?.provider === 'azure-blob' ? false : undefined,
            workspaceFilePaths,
            recordMode: 'full',
        });

        if (workspaceMetadataStore.enabled && workspaceId) {
            await workspaceMetadataStore.upsertWorkspaceFileRecord({
                workspaceId,
                folderName,
                sourceKind: WORKSPACE_SOURCE_UPLOAD,
                path: meta.path,
                status: 'completed',
                record: {
                    ...record,
                    path: meta.path,
                    kind: 'source',
                },
            });
            return;
        }

        workspaceState.files.set(meta.path, {
            ...record,
            path: meta.path,
            kind: 'source',
        });
    });

    // ── Pass 1 complete: build workspace-wide symbol map ──────────────────────
    const symbolMap = new Map();
    const allFiles = workspaceMetadataStore.enabled && workspaceId
        ? await workspaceMetadataStore.listWorkspaceFiles(workspaceId)
        : [...workspaceState.files.values()];

    for (const meta of allFiles) {
        const syms = Array.isArray(meta.symbols) ? meta.symbols : [];
        for (const sym of syms) {
            if (!sym.name) continue;
            const existing = symbolMap.get(sym.name) || [];
            existing.push({ file: meta.path, lineStart: sym.lineStart, lineEnd: sym.lineEnd, kind: sym.kind });
            symbolMap.set(sym.name, existing);
        }
    }
    workspaceState.symbolMap = symbolMap;
    workspaceState.fileAccessMap = new Map();

    // ── Pass 2: resolve call sites against symbol map ─────────────────────────
    await mapWithConcurrency(allFiles, WORKSPACE_ENRICH_CONCURRENCY, async (meta) => {
        if (!Array.isArray(meta.callSites) || meta.callSites.length === 0) return;

        const seen = new Set();
        const resolved = [];
        for (const site of meta.callSites) {
            const key = `${site.calleeName}:${site.callerLine}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const candidates = symbolMap.get(site.calleeName) || [];
            if (!candidates.length) continue;

            const match = candidates.find(c => c.file === meta.path) || candidates[0];
            resolved.push({
                callerLine: site.callerLine,
                calleeName: site.calleeName,
                resolvedFile: match.file,
                resolvedLine: match.lineStart,
            });
            if (resolved.length >= MAX_CALL_SITES_PER_FILE) break;
        }

        const fileRecord = workspaceState.files.get(meta.path);
        if (fileRecord) {
            fileRecord.callSites = resolved;
            // Rebuild calls section with resolved file:line after enrichment
            const MAX_CALLS_SECTION = 30;
            const callsSectionItems = [];
            for (const cs of resolved) {
                if (callsSectionItems.length >= MAX_CALLS_SECTION) break;
                const location = cs.resolvedFile ? `${cs.resolvedFile}:${cs.resolvedLine}` : `line ${cs.callerLine}`;
                callsSectionItems.push({ text: `${cs.calleeName} → ${location}`, priority: 'P1' });
            }
            if (callsSectionItems.length > 0) {
                const updatedSection = { name: 'calls', priority: 'P1', items: callsSectionItems };
                if (Array.isArray(fileRecord.capsuleBase?.sections)) {
                    const idx = fileRecord.capsuleBase.sections.findIndex(s => s.name === 'calls');
                    if (idx >= 0) fileRecord.capsuleBase.sections[idx] = updatedSection;
                    else fileRecord.capsuleBase.sections.push(updatedSection);
                }
                if (Array.isArray(fileRecord.capsuleCache?.capsule?.sections)) {
                    const cacheIdx = fileRecord.capsuleCache.capsule.sections.findIndex(s => s.name === 'calls');
                    if (cacheIdx >= 0) fileRecord.capsuleCache.capsule.sections[cacheIdx] = { ...updatedSection, items: [...callsSectionItems] };
                    else fileRecord.capsuleCache.capsule.sections.push({ ...updatedSection, items: [...callsSectionItems] });
                }
            }
            workspaceState.files.set(meta.path, fileRecord);
        }

        if (workspaceMetadataStore.enabled && workspaceId) {
            await workspaceMetadataStore.upsertWorkspaceFileRecord({
                workspaceId,
                folderName,
                sourceKind: WORKSPACE_SOURCE_UPLOAD,
                path: meta.path,
                record: { ...meta, callSites: resolved },
                status: 'completed',
            });
        }
    });

    // ── Pass 3: build workspace-wide query index ───────────────────────────────
    const queryIndex = new Map();
    const allFilesForIndex = workspaceMetadataStore.enabled && workspaceId
        ? await workspaceMetadataStore.listWorkspaceFiles(workspaceId)
        : [...workspaceState.files.values()];

    for (const meta of allFilesForIndex) {
        const indexEntries = buildQueryIndexEntries(meta);
        for (const entry of indexEntries) {
            const existing = queryIndex.get(entry.token) || [];
            existing.push({
                file: entry.file,
                lineStart: entry.lineStart,
                lineEnd: entry.lineEnd,
                snippet: entry.snippet,
                kind: entry.kind,
                kindBoost: entry.kindBoost,
            });
            queryIndex.set(entry.token, existing);
        }
    }
    workspaceState.queryIndex = queryIndex;

    if (!workspaceMetadataStore.enabled || !workspaceId) {
        workspaceState.indexedAt = new Date().toISOString();
        persistWorkspaceState();
    }
    perf.flush({ enriched: candidates.length, total: indexableFiles.length });
}

async function purgeWorkspace(data = {}) {
    const workspaceId = selectedWorkspaceId(data);
    if (workspaceMetadataStore.enabled && workspaceId) {
        await workspaceMetadataStore.purgeWorkspace(workspaceId);
    }
    clearWorkspaceState();
    return { ok: true, cleared: true, workspaceId };
}

// ── Consolidated .mesh folder generator ──────────────────────────────────────

const FRAMEWORK_PATTERNS = [
    [/express/i, 'Express.js'], [/fastify/i, 'Fastify'], [/react/i, 'React'],
    [/vue/i, 'Vue.js'], [/angular/i, 'Angular'], [/next[\\/]/i, 'Next.js'],
    [/d3/i, 'D3.js'], [/monaco/i, 'Monaco Editor'], [/prisma/i, 'Prisma'],
    [/drizzle/i, 'Drizzle ORM'], [/tailwind/i, 'Tailwind CSS'],
    [/@azure/i, 'Azure SDK'], [/@anthropic/i, 'Anthropic SDK'],
    [/openai/i, 'OpenAI SDK'], [/cosmos/i, 'Azure Cosmos DB'],
    [/socket\.io/i, 'Socket.IO'], [/graphql/i, 'GraphQL'],
    [/jest/i, 'Jest'], [/vitest/i, 'Vitest'], [/playwright/i, 'Playwright'],
    [/webpack/i, 'Webpack'], [/vite/i, 'Vite'], [/esbuild/i, 'esbuild'],
];

const SECRET_RE = /(\$[A-Z_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[A-Z_]*|(?:password|secret|token|api_key)\s*=\s*\S+)/gi;

/**
 * Builds project.json content — structured machine-readable data for the .mesh folder.
 * @param {object[]} files - Workspace file records.
 * @param {string} folderName - Human-readable workspace name.
 * @param {object|null} packageJson - Parsed package.json or null.
 * @returns {string} JSON string.
 */
function buildProjectJson(files, folderName, packageJson) {
    const langCounts = {};
    const frameworkHints = new Set();
    for (const f of files) {
        const lang = f.fileType || f.parserFamily || 'unknown';
        langCounts[lang] = (langCounts[lang] || 0) + 1;
        const sections = f.capsuleCache?.capsule?.sections || f.capsuleBase?.sections || [];
        for (const s of sections) {
            if (s.name !== 'imports' || !Array.isArray(s.items)) continue;
            for (const item of s.items) {
                const src = item.metadata?.source || item.label || '';
                for (const [re, fw] of FRAMEWORK_PATTERNS) {
                    if (re.test(src)) frameworkHints.add(fw);
                }
            }
        }
    }

    const scrubSecrets = (str) => str.replace(SECRET_RE, '[REDACTED]');

    const scripts = {};
    if (packageJson?.scripts && typeof packageJson.scripts === 'object') {
        for (const [k, v] of Object.entries(packageJson.scripts)) {
            scripts[k] = scrubSecrets(String(v));
        }
    }

    const deps = packageJson?.dependencies && typeof packageJson.dependencies === 'object'
        ? Object.keys(packageJson.dependencies) : [];
    const devDeps = packageJson?.devDependencies && typeof packageJson.devDependencies === 'object'
        ? Object.keys(packageJson.devDependencies) : [];

    return JSON.stringify({
        metadata: {
            generatedAt: new Date().toISOString(),
            workspace: folderName,
            fileCount: files.length,
            generator: 'mesh-ide',
        },
        languages: langCounts,
        frameworks: [...frameworkHints],
        scripts,
        dependencies: deps.slice(0, 30),
        devDependencies: devDeps.slice(0, 20),
    }, null, 2);
}

/**
 * Builds files.md content — directory tree, dependency hubs, and API surface.
 * @param {object[]} files - Workspace file records.
 * @param {string} folderName - Human-readable workspace name.
 * @returns {string} Markdown string with YAML frontmatter.
 */
/**
 * Classifies a workspace-relative file path into a role bucket.
 * @param {string} relPath - Workspace-relative file path.
 * @returns {string} Role: entry-point | route-handler | service | model | middleware | config | test | util
 */
function classifyFileRole(relPath) {
    const p = String(relPath || '');
    if (/\.(test|spec)\.(cjs|js|ts|mjs)$/.test(p) || /[/\\]tests?[/\\]/.test(p) || /\.test$/.test(p)) return 'test';
    if (/\.routes\.(js|ts|cjs)$/.test(p) || /[/\\]routes[/\\]/.test(p)) return 'route-handler';
    if (/\bmiddleware\b/.test(p)) return 'middleware';
    // config check before entry-point: src/config/index.js is config, not entry-point
    if (/\.(config|rc)\.(js|ts|cjs|json)$/.test(p) || /rc\.(js|ts|cjs|json)$/.test(p) || /(^|[/\\])config[/\\]/.test(p) || /config\.(js|ts|cjs)$/.test(p)) return 'config';
    if (/\b(server|app|main|index)\.(js|ts|cjs)$/.test(p)) return 'entry-point';
    if (/\bservices?\b/.test(p) || /-service\.(js|ts|cjs)$/.test(p) || /-core\.(js|ts|cjs)$/.test(p)) return 'service';
    if (/\b(models?|schemas?)\b/.test(p) || /\.(model|schema)\.(js|ts|cjs)$/.test(p)) return 'model';
    return 'util';
}

function buildFilesMd(files, folderName) {
    const now = new Date().toISOString();
    const lines = [
        '---',
        `generated: "${now}"`,
        `workspace: "${folderName}"`,
        `files: ${files.length}`,
        '---',
        '',
        `# ${folderName} -- File Index`,
        '',
    ];

    const topDirs = new Map();
    const fileList = [];
    for (const f of files) {
        const rawPath = String(f.path || '');
        const relPath = rawPath.startsWith(`${folderName}/`) ? rawPath.slice(folderName.length + 1) : rawPath;
        if (!relPath) continue;
        fileList.push(relPath);
        const firstSeg = relPath.split('/')[0];
        if (relPath.includes('/')) topDirs.set(firstSeg, (topDirs.get(firstSeg) || 0) + 1);
    }
    fileList.sort();

    lines.push('## Directory Structure', '');
    const rootFiles = fileList.filter(fp => !fp.includes('/'));
    for (const [dir, count] of [...topDirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`- ${dir}/ (${count} file${count !== 1 ? 's' : ''})`);
    }
    for (const rf of rootFiles) lines.push(`- ${rf}`);
    lines.push('');

    const importedByCount = new Map();
    for (const f of files) {
        if (!Array.isArray(f.dependencies)) continue;
        for (const dep of f.dependencies) importedByCount.set(dep, (importedByCount.get(dep) || 0) + 1);
    }
    const hubs = [...importedByCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (hubs.length > 0) {
        lines.push('## Dependency Hubs', '', '| File | Imported by |', '|------|------------|');
        for (const [fp, count] of hubs) {
            const relFp = fp.startsWith(`${folderName}/`) ? fp.slice(folderName.length + 1) : fp;
            lines.push(`| \`${relFp}\` | ${count} file${count !== 1 ? 's' : ''} |`);
        }
        lines.push('');
    }

    const exports = [];
    const endpoints = [];
    for (const f of files) {
        const relFp = String(f.path || '').startsWith(`${folderName}/`) ? String(f.path).slice(folderName.length + 1) : String(f.path || '');
        const sections = f.capsuleCache?.capsule?.sections || f.capsuleBase?.sections || [];
        for (const s of sections) {
            if (!Array.isArray(s.items)) continue;
            if (s.name === 'exports' || s.name === 'functions' || s.name === 'classes') {
                for (const item of s.items) {
                    const label = item.label || item.name || '';
                    if (label && exports.length < 60) exports.push(`- \`${label}\` -- ${relFp}`);
                }
            }
            if (s.name === 'routes' || s.name === 'endpoints') {
                for (const item of s.items) {
                    const method = item.metadata?.method ? `${item.metadata.method} ` : '';
                    const label = item.label || '';
                    if (label && endpoints.length < 40) endpoints.push(`- \`${method}${label}\` -- ${relFp}`);
                }
            }
        }
    }
    if (exports.length > 0 || endpoints.length > 0) {
        lines.push('## API Surface', '');
        if (exports.length > 0) { lines.push('### Exports', '', ...exports, ''); }
        if (endpoints.length > 0) { lines.push('### HTTP Endpoints', '', ...endpoints, ''); }
    }

    const ROLE_ORDER = ['entry-point', 'route-handler', 'service', 'model', 'middleware', 'config', 'test', 'util'];
    const roleMap = new Map(ROLE_ORDER.map(r => [r, []]));
    for (const f of files) {
        const rawPath = String(f.path || '');
        const relFp = rawPath.startsWith(`${folderName}/`) ? rawPath.slice(folderName.length + 1) : rawPath;
        if (!relFp) continue;
        const role = classifyFileRole(relFp);
        if (roleMap.has(role)) roleMap.get(role).push(relFp);
    }
    const nonEmptyRoles = ROLE_ORDER.filter(r => roleMap.get(r).length > 0);
    if (nonEmptyRoles.length > 0) {
        lines.push('## File Roles', '', '| Role | Files |', '|------|-------|');
        for (const role of nonEmptyRoles) {
            const roleFiles = roleMap.get(role).sort().join(', ');
            lines.push(`| ${role} | ${roleFiles} |`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Builds rules.md content — detected coding conventions and workspace-specific rules.
 * @param {object[]} files - Workspace file records.
 * @param {string} folderName - Human-readable workspace name.
 * @returns {string} Markdown string with YAML frontmatter.
 */
function buildRulesMd(files, folderName) {
    const now = new Date().toISOString();
    const jsFiles = files.filter(f => /\.(js|ts|jsx|tsx)$/.test(f.path || ''));
    const indentSamples = [];
    for (const f of files.slice(0, 20)) {
        const raw = f.rawStorage?.content || f.modelContent || '';
        const m = raw.match(/^(  |\t)/m);
        if (m) indentSamples.push(m[1] === '\t' ? 'tabs' : '2-spaces');
    }
    const indent = indentSamples.filter(x => x === 'tabs').length > indentSamples.length / 2 ? 'tabs' : '2 spaces';

    const langCounts = {};
    for (const f of files) {
        const lang = f.fileType || f.parserFamily || 'unknown';
        langCounts[lang] = (langCounts[lang] || 0) + 1;
    }
    const topLangs = Object.entries(langCounts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, c]) => `${l} (${c})`).join(', ');

    const lines = [
        '---',
        `generated: "${now}"`,
        `workspace: "${folderName}"`,
        '---',
        '',
        `# ${folderName} -- Coding Rules`,
        '',
        '## Detected Conventions',
        '',
        `- **Indentation:** ${indent}`,
        `- **Primary languages:** ${topLangs || 'unknown'}`,
        `- **JS/TS files:** ${jsFiles.length}`,
        '',
        '## Rules',
        '',
        '- Match the indentation style of the file being edited.',
        '- Prefer editing existing files over creating new ones.',
        '- Keep changes minimal and focused on the task.',
        '- Write complete, production-ready code. No TODOs or placeholders.',
        '- Do not add comments unless the logic is non-obvious.',
        '- Security: never hardcode secrets, always use parameterized queries, validate all external input.',
        '',
    ];

    return lines.join('\n');
}

/**
 * Provisions the .mesh/ folder with 3 consolidated files: project.json, files.md, rules.md.
 * Replaces the old scattered generators (provisionMeshFile, provisionIntelligenceArtifacts,
 * provisionDependencyMap, provisionMeshWorkspaceMetadata).
 *
 * @param {object} ctx
 * @param {string} [ctx.rootPath] - Absolute path to the workspace root (local workspaces).
 * @param {string} [ctx.workspaceId] - Cloud workspace ID.
 * @param {string} [ctx.folderName] - Human-readable project name.
 * @returns {Promise<void>}
 */
async function provisionMeshFolder(ctx = {}) {
    const { rootPath, workspaceId, folderName } = ctx;
    const name = folderName || workspaceState.folderName || 'workspace';

    let files = [];
    if (workspaceMetadataStore.enabled && workspaceId) {
        files = await workspaceMetadataStore.listWorkspaceFiles(workspaceId);
    } else if (workspaceState.folderName || workspaceState.workspaceId) {
        files = [...workspaceState.files.values()];
    }
    if (!files.length) return;

    let packageJson = null;
    if (rootPath) {
        try {
            const raw = await fs.promises.readFile(path.join(rootPath, 'package.json'), 'utf8');
            packageJson = JSON.parse(raw);
        } catch {}
    }

    const projectJson = buildProjectJson(files, name, packageJson);
    const filesMd = buildFilesMd(files, name);
    const rulesMd = buildRulesMd(files, name);

    if (rootPath) {
        const meshDir = path.join(rootPath, '.mesh');
        await fs.promises.mkdir(meshDir, { recursive: true });
        await Promise.all([
            fs.promises.writeFile(path.join(meshDir, 'project.json'), projectJson, 'utf8'),
            fs.promises.writeFile(path.join(meshDir, 'files.md'), filesMd, 'utf8'),
            fs.promises.writeFile(path.join(meshDir, 'rules.md'), rulesMd, 'utf8'),
        ]);
        console.log(`[mesh] Provisioned .mesh folder (3 files) at ${meshDir}`);
        return;
    }

    if (workspaceMetadataStore.enabled && workspaceId) {
        const meshFiles = [
            { filename: 'project.json', content: projectJson, parser: 'json' },
            { filename: 'files.md', content: filesMd, parser: 'markdown' },
            { filename: 'rules.md', content: rulesMd, parser: 'markdown' },
        ];
        for (const { filename, content, parser } of meshFiles) {
            const fullPath = `${name}/.mesh/${filename}`;
            await workspaceMetadataStore.upsertWorkspaceFileRecord({
                workspaceId,
                folderName: name,
                sourceKind: WORKSPACE_SOURCE_UPLOAD,
                path: fullPath,
                status: 'completed',
                record: {
                    path: fullPath,
                    kind: 'source',
                    description: `Mesh AI .mesh/${filename}`,
                    originalSize: content.length,
                    compressedSize: content.length,
                    modelContent: content,
                    capsuleMode: 'none',
                    parserFamily: parser,
                    storage: { provider: 'virtual', blobPath: fullPath },
                },
            });
        }
        console.log(`[mesh] Provisioned .mesh folder (3 files) for cloud workspace ${workspaceId}`);
    }
}

async function openWorkspaceFile(data) {
    const requested = toSafePath(data?.path);
    const viewMode = String(data?.view || 'original');
    // Use Cosmos whenever store is enabled AND a workspaceId is available (from request OR RAM state).
    // Do NOT require isUploadWorkspace() — that checks RAM state which is lost on worker restart.
    const cosmosWorkspaceId = workspaceMetadataStore.enabled ? selectedWorkspaceId(data) : '';
    if (workspaceMetadataStore.enabled && cosmosWorkspaceId) {
        const workspaceId = cosmosWorkspaceId;
        const meta = await workspaceMetadataStore.getWorkspaceFile(workspaceId, requested);
        if (!meta) {
            return { ok: false, error: 'File not found in selected workspace' };
        }
        const isIndexed = String(meta.status || '').toLowerCase() === 'completed';

        // If capsule/compressed view requested but not indexed yet → fall back to raw from blob
        if (!isIndexed || viewMode === 'original') {
            // Always serve raw from blob for 'original' view or pending files
            const storage = meta.storage || null;
            if (storage) {
                try {
                    const rawResult = await readWorkspaceBlobText(storage, Number(meta.originalSize || meta.rawBytes || 0));
                    return {
                        ok: true,
                        path: requested,
                        content: rawResult.content,
                        view: 'original',
                        originalSize: rawResult.byteLength || Number(meta.originalSize || 0),
                        compressedSize: 0,
                        indexed: isIndexed,
                        status: String(meta.status || 'pending'),
                    };
                } catch (blobErr) {
                    return { ok: false, error: `Could not read file from storage: ${blobErr?.message}` };
                }
            }
            if (!isIndexed) {
                return { ok: false, error: 'File is still indexing and has no blob storage reference.', indexing: true };
            }
        }

        await syncUploadWorkspaceSummary(workspaceId, {
            folderName: meta.folderName || workspaceState.folderName,
            sessionId: meta.sessionId || workspaceState.sessionId,
        });
        return buildWorkspaceFileView(meta, viewMode, {
            path: requested,
            tier: String(data?.tier || data?.capsuleTier || data?.variant || ''),
            query: String(data?.query || data?.focus || ''),
            focus: String(data?.focus || data?.query || ''),
            legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
        });
    }
    const meta = workspaceState.files.get(requested);

    if (!meta) {
        return { ok: false, error: 'File not found in selected workspace' };
    }

    if (!workspaceRecordIndexed(meta)) {
        return { ok: false, error: 'File is still indexing. Please retry in a moment.', indexing: true };
    }

    return buildWorkspaceFileView(meta, data?.view || 'original', {
        path: requested,
        tier: String(data?.tier || data?.capsuleTier || data?.variant || ''),
        query: String(data?.query || data?.focus || ''),
        focus: String(data?.focus || data?.query || ''),
        legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
    });
}

async function recoverWorkspaceSpans(data = {}) {
    const requested = toSafePath(data?.path);
    if (workspaceMetadataStore.enabled && isUploadWorkspace()) {
        const workspaceId = selectedWorkspaceId(data);
        const meta = await workspaceMetadataStore.getWorkspaceFile(workspaceId, requested);
        if (!meta) {
            return { ok: false, error: 'File not found in selected workspace' };
        }
        if (String(meta.status || '').toLowerCase() !== 'completed') {
            return { ok: false, error: 'File is still indexing. Please retry in a moment.', indexing: true };
        }
        const spanIds = Array.isArray(data?.spanIds) && data.spanIds.length
            ? data.spanIds
            : (data?.query ? suggestRecoverySpanIds(meta, data.query, 4) : []);
        const rawText = await loadWorkspaceRecordText(meta, requested);
        const recovered = await recoverWorkspaceFileRecord(meta, {
            spanIds,
            ranges: Array.isArray(data?.ranges) ? data.ranges : [],
        }, {
            path: requested,
            rawText,
            legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
        });
        return {
            ...recovered,
            suggestedSpanIds: spanIds,
        };
    }
    const meta = workspaceState.files.get(requested);
    if (!meta) {
        return { ok: false, error: 'File not found in selected workspace' };
    }
    if (!workspaceRecordIndexed(meta)) {
        return { ok: false, error: 'File is still indexing. Please retry in a moment.', indexing: true };
    }

    const ensured = await ensureWorkspaceMeta(meta, requested);
    const spanIds = Array.isArray(data?.spanIds) && data.spanIds.length
        ? data.spanIds
        : (data?.query ? suggestRecoverySpanIds(ensured, data.query, 4) : []);
    const recovered = await recoverWorkspaceFileRecord(ensured, {
        spanIds,
        ranges: Array.isArray(data?.ranges) ? data.ranges : [],
    }, {
        path: requested,
        rawText: await loadWorkspaceRecordText(ensured, requested),
        legacyBrotliQuality: WORKSPACE_BROTLI_QUALITY,
    });
    return {
        ...recovered,
        suggestedSpanIds: spanIds,
    };
}

async function saveWorkspaceFile(data) {
    const requested = ensureWorkspaceOwnedPath(data?.path, workspaceState.folderName || data?.folderName);
    if (!requested || requested.endsWith('/')) {
        return { ok: false, error: 'Invalid file path' };
    }

    const content = typeof data?.content === 'string' ? data.content : String(data?.content || '');
    if (isLocalPathWorkspace()) {
        const result = await writeLocalWorkspaceFileToDisk(requested, content, { overwrite: true });
        if (result?.ok) workspaceState.fileAccessMap.set(requested, Date.now());
        return result;
    }
    if (workspaceMetadataStore.enabled && isUploadWorkspace()) {
        const workspaceId = selectedWorkspaceId(data);
        const existing = await workspaceMetadataStore.getWorkspaceFile(workspaceId, requested);
        const compressed = existing?.storage?.provider === 'azure-blob'
            ? await packBlobBackedWorkspaceRecord(requested, content, {
                storage: existing.storage,
                writeToBlob: true,
            })
            : await packBlobBackedWorkspaceRecord(requested, content, {
                storage: workspaceUploadBlobStorageForPath(requested),
                writeToBlob: true,
            });
        await workspaceMetadataStore.upsertWorkspaceFileRecord({
            workspaceId,
            sessionId: workspaceState.sessionId,
            folderName: workspaceState.folderName || data?.folderName || 'workspace',
            rootPath: '',
            sourceKind: WORKSPACE_SOURCE_UPLOAD,
            path: requested,
            record: compressed,
            status: 'completed',
        });
        await syncUploadWorkspaceSummary(workspaceId, {
            folderName: workspaceState.folderName || data?.folderName || 'workspace',
            sessionId: workspaceState.sessionId,
        });
        workspaceState.fileAccessMap.set(requested, Date.now());
        return {
            ok: true,
            path: requested,
            originalSize: compressed.originalSize,
            compressedSize: compressed.compressedSize,
            capsuleBytes: Number(compressed.compressionStats?.capsuleBytes || 0),
            transportBytes: Number(compressed.compressionStats?.transportBytes || 0),
            updatedAt: workspaceState.indexedAt,
        };
    }

    const existing = workspaceState.files.get(requested);
    const compressed = existing?.storage?.provider === 'azure-blob'
        ? await packBlobBackedWorkspaceRecord(requested, content, {
            storage: existing.storage,
            writeToBlob: true,
        })
        : await packWorkspaceContentRecord(requested, content);

    workspaceState.files.set(requested, {
        path: requested,
        ...compressed,
        kind: 'source',
    });

    if (!workspaceState.folderName) {
        workspaceState.folderName = 'workspace';
    }
    workspaceState.rootPath = null;
    workspaceState.sourceKind = WORKSPACE_SOURCE_UPLOAD;
    workspaceState.indexedAt = new Date().toISOString();
    persistWorkspaceState();
    workspaceState.fileAccessMap.set(requested, Date.now());

    return {
        ok: true,
        path: requested,
        originalSize: compressed.originalSize,
        compressedSize: compressed.compressedSize,
        capsuleBytes: Number(compressed.compressionStats?.capsuleBytes || 0),
        transportBytes: Number(compressed.compressionStats?.transportBytes || 0),
        updatedAt: workspaceState.indexedAt,
    };
}

async function createWorkspaceFile(data) {
    const requested = ensureWorkspaceOwnedPath(data?.path, workspaceState.folderName || data?.folderName);
    if (!requested || requested.endsWith('/')) {
        return { ok: false, error: 'Invalid file path' };
    }

    const overwrite = Boolean(data?.overwrite);
    const existed = workspaceState.files.has(requested);
    if (existed && !overwrite) {
        return { ok: false, error: 'File already exists' };
    }

    const content = typeof data?.content === 'string' ? data.content : String(data?.content || '');
    if (isLocalPathWorkspace()) {
        const result = await writeLocalWorkspaceFileToDisk(requested, content, { overwrite });
        if (result.ok === false) return result;
        return {
            ...result,
            created: !existed,
            overwritten: existed,
        };
    }
    if (workspaceMetadataStore.enabled && isUploadWorkspace()) {
        const workspaceId = selectedWorkspaceId(data);
        const existing = await workspaceMetadataStore.getWorkspaceFile(workspaceId, requested);
        if (existing && !overwrite) {
            return { ok: false, error: 'File already exists' };
        }
        const compressed = existing?.storage?.provider === 'azure-blob'
            ? await packBlobBackedWorkspaceRecord(requested, content, {
                storage: existing.storage,
                writeToBlob: true,
            })
            : await packBlobBackedWorkspaceRecord(requested, content, {
                storage: workspaceUploadBlobStorageForPath(requested),
                writeToBlob: true,
            });
        await workspaceMetadataStore.upsertWorkspaceFileRecord({
            workspaceId,
            sessionId: workspaceState.sessionId,
            folderName: workspaceState.folderName || data?.folderName || 'workspace',
            rootPath: '',
            sourceKind: WORKSPACE_SOURCE_UPLOAD,
            path: requested,
            record: compressed,
            status: 'completed',
        });
        await syncUploadWorkspaceSummary(workspaceId, {
            folderName: workspaceState.folderName || data?.folderName || 'workspace',
            sessionId: workspaceState.sessionId,
        });
        return {
            ok: true,
            path: requested,
            created: !existing,
            overwritten: Boolean(existing),
            originalSize: compressed.originalSize,
            compressedSize: compressed.compressedSize,
            capsuleBytes: Number(compressed.compressionStats?.capsuleBytes || 0),
            transportBytes: Number(compressed.compressionStats?.transportBytes || 0),
            updatedAt: workspaceState.indexedAt,
        };
    }

    const existing = workspaceState.files.get(requested);
    const compressed = existing?.storage?.provider === 'azure-blob'
        ? await packBlobBackedWorkspaceRecord(requested, content, {
            storage: existing.storage,
            writeToBlob: true,
        })
        : await packBlobBackedWorkspaceRecord(requested, content, {
            storage: workspaceUploadBlobStorageForPath(requested),
            writeToBlob: true,
        });

    workspaceState.files.set(requested, {
        path: requested,
        ...compressed,
        kind: 'source',
    });

    if (!workspaceState.folderName) {
        workspaceState.folderName = String(data?.folderName || 'workspace') || 'workspace';
    }
    workspaceState.rootPath = null;
    workspaceState.sourceKind = WORKSPACE_SOURCE_UPLOAD;
    workspaceState.indexedAt = new Date().toISOString();
    persistWorkspaceState();

    return {
        ok: true,
        path: requested,
        created: !existed,
        overwritten: existed,
        originalSize: compressed.originalSize,
        compressedSize: compressed.compressedSize,
        capsuleBytes: Number(compressed.compressionStats?.capsuleBytes || 0),
        transportBytes: Number(compressed.compressionStats?.transportBytes || 0),
        updatedAt: workspaceState.indexedAt,
    };
}

/**
 * Returns true if candidatePath is a test-pair counterpart of activeFilePath.
 * @param {string} candidatePath
 * @param {string|null} activeFilePath
 * @returns {boolean}
 */
function isTestPairOf(candidatePath, activeFilePath) {
    if (!activeFilePath) return false;
    const activeBase = basename(String(activeFilePath));
    const activeStem = activeBase.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '');
    if (!activeStem) return false;
    const candidateName = basename(String(candidatePath));
    return (
        candidateName === `${activeStem}.test.js`  ||
        candidateName === `${activeStem}.spec.js`  ||
        candidateName === `${activeStem}.test.ts`  ||
        candidateName === `${activeStem}.spec.ts`  ||
        candidateName === `${activeStem}.test.cjs` ||
        candidateName === `test-${activeStem}.js`
    );
}

/**
 * Optional vector similarity boost. Returns 0 until MESH_VECTOR_ENABLED is set
 * and .mesh/vectors/ files exist. Activation is deferred to Phase 57 benchmarks.
 * @param {string} _path
 * @param {string[]} _queryTokens
 * @returns {number}
 */
function vectorBoost(_path, _queryTokens) {
    return 0;
}

const RECENCY_BUCKETS = [
    { maxMinutes: 2,   boost: 50 },
    { maxMinutes: 10,  boost: 35 },
    { maxMinutes: 60,  boost: 20 },
    { maxMinutes: 360, boost: 10 },
];

const FILE_ROLE_BOOSTS = {
    'entry-point':   25,
    'service':       15,
    'route-handler': 15,
    'config':        10,
    'test':          10,
};
const FILE_ROLE_TEST_QUERY_BOOST = 20;

/**
 * Computes a hybrid rank score fusing path, symbol, role, recency, test-pair,
 * graph-proximity, and optional vector signals.
 *
 * @param {string} pathValue - File path to score
 * @param {{rawText:string, compactText:string, tokens:string[]}} queryContext
 * @param {{activeFile?:string, symbolHitFiles:Set<string>, calleeFiles:Set<string>, queryTokens:string[]}} opts
 * @returns {{score:number, reasons:string[]}}
 */
function hybridRankFiles(pathValue, queryContext, opts) {
    const {
        activeFile     = null,
        symbolHitFiles = new Set(),
        calleeFiles    = new Set(),
        queryTokens    = [],
    } = opts || {};

    const reasons = [];

    // ── 1. Path token score (existing signal) ────────────────────────────────
    const pathScore = scorePathForQuery(pathValue, queryContext);
    if (pathScore > 0) reasons.push(`path: ${basename(pathValue)} (+${pathScore})`);

    // ── 2. Symbol hit boost ───────────────────────────────────────────────────
    const SYMBOL_HIT_BOOST = 40;
    const symbolHit = symbolHitFiles.has(pathValue);
    if (symbolHit) reasons.push(`symbol hit (+${SYMBOL_HIT_BOOST})`);

    // ── 3. Active-file boost ──────────────────────────────────────────────────
    const ACTIVE_FILE_BOOST = 60;
    const isActiveFile = Boolean(activeFile && pathValue === activeFile);
    if (isActiveFile) reasons.push(`active-file (+${ACTIVE_FILE_BOOST})`);

    // ── 4. Test-pair boost ────────────────────────────────────────────────────
    const TEST_PAIR_BOOST = 35;
    const testPair = !isActiveFile && isTestPairOf(pathValue, activeFile);
    if (testPair) reasons.push(`test-pair (+${TEST_PAIR_BOOST})`);

    // ── 5. Graph proximity boost ──────────────────────────────────────────────
    const GRAPH_PROXIMITY_BOOST = 20;
    const isCallee = !symbolHit && calleeFiles.has(pathValue);
    if (isCallee) reasons.push(`graph: callee (+${GRAPH_PROXIMITY_BOOST})`);

    // ── 6. Recency boost ──────────────────────────────────────────────────────
    let recencyBoost = 0;
    const accessedAt = workspaceState.fileAccessMap.get(pathValue);
    if (accessedAt) {
        const ageMinutes = Math.floor((Date.now() - accessedAt) / 60000);
        for (const bucket of RECENCY_BUCKETS) {
            if (ageMinutes <= bucket.maxMinutes) {
                recencyBoost = bucket.boost;
                reasons.push(`recency: ${ageMinutes}m ago (+${recencyBoost})`);
                break;
            }
        }
    }

    // ── 7. File role boost ────────────────────────────────────────────────────
    const role = classifyFileRole(pathValue);
    const queryMentionsTest = /\btest[s]?\b|\bspec\b/i.test(queryContext.rawText);
    const roleBoost = role === 'test' && queryMentionsTest
        ? FILE_ROLE_TEST_QUERY_BOOST
        : (FILE_ROLE_BOOSTS[role] || 0);
    if (roleBoost > 0) reasons.push(`role: ${role} (+${roleBoost})`);

    // ── 8. Vector boost (dormant hook — RET-02) ───────────────────────────────
    const vBoost = vectorBoost(pathValue, queryTokens);

    const score = pathScore
        + (symbolHit ? SYMBOL_HIT_BOOST : 0)
        + (isActiveFile ? ACTIVE_FILE_BOOST : 0)
        + (testPair ? TEST_PAIR_BOOST : 0)
        + (isCallee ? GRAPH_PROXIMITY_BOOST : 0)
        + recencyBoost
        + roleBoost
        + vBoost;

    return { score, reasons: reasons.slice(0, 4) };
}

function buildWorkspaceQueryContext(rawQuery) {
    const rawText = String(rawQuery || '').toLowerCase();
    return {
        rawText,
        compactText: rawText.replace(/[^a-z0-9]+/g, ''),
        tokens: extractSearchTokens(rawText),
    };
}

function resolveQueryIndexSnippets(q, limit) {
    if (!q || !(workspaceState.queryIndex instanceof Map) || workspaceState.queryIndex.size === 0) return [];
    const queryTokens = extractSearchTokens(q);
    if (!queryTokens.length) return [];

    const scoreMap = new Map(); // key: `${file}:${lineStart}` -> { entry, score }
    for (const token of queryTokens) {
        const hits = workspaceState.queryIndex.get(token) || [];
        for (const hit of hits) {
            const key = `${hit.file}:${hit.lineStart}`;
            const existing = scoreMap.get(key);
            if (existing) {
                existing.score += 1 + (hit.kindBoost || 0);
            } else {
                scoreMap.set(key, { entry: hit, score: 1 + (hit.kindBoost || 0) });
            }
        }
    }

    return [...scoreMap.values()]
        .sort((a, b) => b.score - a.score || a.entry.lineStart - b.entry.lineStart)
        .slice(0, Math.max(1, Number(limit) || MAX_QUERY_SNIPPETS))
        .map((item) => ({
            file: item.entry.file,
            lineStart: item.entry.lineStart,
            lineEnd: item.entry.lineEnd,
            snippet: item.entry.snippet,
            kind: item.entry.kind,
            score: item.score,
        }));
}

async function searchWorkspace(data = {}) {
    const q = String(data?.q || data?.query || '').trim();
    const activeFile = data?.activeFile ? String(data.activeFile) : null;
    const limit = Math.min(Math.max(Number(data?.limit) || 12, 1), 50);
    const extensionHints = extractQueryExtensionHints(q);
    const queryContext = buildWorkspaceQueryContext(q);
    const snippets = resolveQueryIndexSnippets(q, MAX_QUERY_SNIPPETS);

    // Pre-compute signal sets for hybridRankFiles (O(snippets) — done once, not per-file)
    const symbolHitFiles = new Set(snippets.map((s) => s.file));
    const calleeFiles = new Set();
    if (q) {
        for (const hitFile of symbolHitFiles) {
            const record = workspaceState.files.get(hitFile);
            if (!record?.callSites) continue;
            for (const cs of record.callSites) {
                if (cs.resolvedFile) calleeFiles.add(cs.resolvedFile);
            }
        }
    }
    const hybridOpts = { activeFile, symbolHitFiles, calleeFiles, queryTokens: queryContext.tokens };

    if (workspaceMetadataStore.enabled && isUploadWorkspace()) {
        const workspaceId = selectedWorkspaceId(data);
        const docs = await workspaceMetadataStore.listWorkspaceFiles(workspaceId);
        let matches = docs.map((meta) => {
            const { score, reasons } = q
                ? hybridRankFiles(meta.path, queryContext, hybridOpts)
                : { score: 1, reasons: [] };
            return {
                path: meta.path,
                name: basename(meta.path),
                score,
                reasons,
                indexed: workspaceRecordIndexed(meta),
                originalSize: Number(meta?.originalSize || 0),
                compressedSize: Number(meta?.compressedSize || 0),
                kind: meta?.kind || (workspaceRecordIndexed(meta) ? 'source' : 'pending'),
                fileType: String(meta?.fileType || ''),
                parserFamily: String(meta?.parserFamily || ''),
                parseOk: Boolean(meta?.parseOk),
                capsuleMode: String(meta?.capsuleMode || ''),
                status: String(meta?.status || ''),
            };
        }).filter((entry) => !q || entry.score > 0);

        if (extensionHints.size > 0) {
            const filtered = matches.filter((entry) => pathHasExtensionHint(entry.path, extensionHints));
            if (filtered.length > 0) matches = filtered;
        }

        matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));

        if (q) {
            const now = Date.now();
            for (const m of matches.slice(0, limit)) {
                workspaceState.fileAccessMap.set(m.path, now);
            }
        }

        if (typeof workspaceState !== 'undefined' && workspaceState?.retrievalStats) {
            workspaceState.retrievalStats.queries++;
            if (!matches.length) workspaceState.retrievalStats.misses++;
        }
        return {
            ok: true,
            query: q,
            limit,
            matches: matches.slice(0, limit),
            total: matches.length,
            snippets,
        };
    }

    let matches = sortedWorkspacePaths().map((pathValue) => {
        const meta = workspaceState.files.get(pathValue);
        const { score, reasons } = q
            ? hybridRankFiles(pathValue, queryContext, hybridOpts)
            : { score: 1, reasons: [] };
        return {
            path: pathValue,
            name: basename(pathValue),
            score,
            reasons,
            indexed: workspaceRecordIndexed(meta),
            originalSize: Number(meta?.originalSize || 0),
            compressedSize: Number(meta?.compressedSize || 0),
            kind: meta?.kind || (workspaceRecordIndexed(meta) ? 'source' : 'pending'),
            fileType: String(meta?.fileType || ''),
            parserFamily: String(meta?.parserFamily || ''),
            parseOk: Boolean(meta?.parseOk),
            capsuleMode: String(meta?.capsuleMode || ''),
        };
    }).filter((entry) => !q || entry.score > 0);

    if (extensionHints.size > 0) {
        const filtered = matches.filter((entry) => pathHasExtensionHint(entry.path, extensionHints));
        if (filtered.length > 0) matches = filtered;
    }

    matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));

    if (q) {
        const now = Date.now();
        for (const m of matches.slice(0, limit)) {
            workspaceState.fileAccessMap.set(m.path, now);
        }
    }

    if (typeof workspaceState !== 'undefined' && workspaceState?.retrievalStats) {
        workspaceState.retrievalStats.queries++;
        if (!matches.length) workspaceState.retrievalStats.misses++;
    }
    return {
        ok: true,
        query: q,
        limit,
        matches: matches.slice(0, limit),
        total: matches.length,
        snippets,
    };
}

function findMatchesInText(content, query, options = {}) {
    const text = String(content || '');
    const needle = String(query || '');
    if (!text || !needle) return [];

    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const caseSensitive = options.caseSensitive === true;
    const normalizedNeedle = caseSensitive ? needle : needle.toLowerCase();
    const hits = [];

    for (let i = 0; i < lines.length; i += 1) {
        const line = String(lines[i] || '');
        const haystack = caseSensitive ? line : line.toLowerCase();
        let offset = 0;

        while (offset <= haystack.length) {
            const idx = haystack.indexOf(normalizedNeedle, offset);
            if (idx < 0) break;
            hits.push({
                lineNumber: i + 1,
                column: idx + 1,
                line,
                preview: line.trim().slice(0, 240),
            });
            offset = idx + Math.max(1, normalizedNeedle.length);
        }
    }

    return hits;
}

async function grepWorkspace(data = {}) {
    const q = String(data?.q || data?.query || '').trim();
    if (!q) return { ok: false, error: 'Search query is required.' };

    const limit = Math.min(Math.max(Number(data?.limit) || 40, 1), 200);
    const extensionHints = extractQueryExtensionHints(q);
    let scannedFiles = 0;
    const matches = [];

    if (workspaceMetadataStore.enabled && isUploadWorkspace()) {
        const workspaceId = selectedWorkspaceId(data);
        const docs = await workspaceMetadataStore.listWorkspaceFiles(workspaceId);

        for (const meta of docs) {
            const pathValue = toSafePath(meta?.path || '');
            if (!pathValue || !workspaceRecordIndexed(meta)) continue;
            if (extensionHints.size > 0 && !pathHasExtensionHint(pathValue, extensionHints)) continue;

            const decoded = await loadWorkspaceRecordText(meta, pathValue);
            const fileHits = findMatchesInText(decoded, q, data);
            scannedFiles += 1;

            for (const hit of fileHits) {
                matches.push({ path: pathValue, ...hit });
                if (matches.length >= limit) {
                    return { ok: true, query: q, limit, scannedFiles, matches, truncated: true };
                }
            }
        }

        return { ok: true, query: q, limit, scannedFiles, matches, truncated: false };
    }

    for (const pathValue of sortedWorkspacePaths()) {
        const meta = workspaceState.files.get(pathValue);
        if (!workspaceRecordIndexed(meta)) continue;
        if (extensionHints.size > 0 && !pathHasExtensionHint(pathValue, extensionHints)) continue;

        const ensured = await ensureWorkspaceMeta(meta, pathValue);
        const decoded = await loadWorkspaceRecordText(ensured, pathValue);
        const fileHits = findMatchesInText(decoded, q, data);
        scannedFiles += 1;

        for (const hit of fileHits) {
            matches.push({ path: pathValue, ...hit });
            if (matches.length >= limit) {
                return { ok: true, query: q, limit, scannedFiles, matches, truncated: true };
            }
        }
    }

    return { ok: true, query: q, limit, scannedFiles, matches, truncated: false };
}

async function renameWorkspaceFile(data = {}) {
    const fromPath = ensureWorkspaceOwnedPath(data?.fromPath, workspaceState.folderName || data?.folderName);
    const toPath = ensureWorkspaceOwnedPath(data?.toPath, workspaceState.folderName || data?.folderName);
    const overwrite = Boolean(data?.overwrite);

    if (!fromPath || !toPath || fromPath.endsWith('/') || toPath.endsWith('/')) {
        return { ok: false, error: 'Invalid rename path.' };
    }
    if (fromPath === toPath) {
        return { ok: false, error: 'Source and target paths are identical.' };
    }

    const source = workspaceState.files.get(fromPath);
    if (workspaceMetadataStore.enabled && isUploadWorkspace()) {
        const workspaceId = selectedWorkspaceId(data);
        const sourceDoc = await workspaceMetadataStore.getWorkspaceFile(workspaceId, fromPath);
        if (!sourceDoc) return { ok: false, error: 'Source file not found.' };
        const targetDoc = await workspaceMetadataStore.getWorkspaceFile(workspaceId, toPath);
        if (targetDoc && !overwrite) return { ok: false, error: 'Target file already exists.' };
        const targetStorage = workspaceUploadBlobStorageForPath(toPath);
        if (!targetStorage) return { ok: false, error: 'Target blob path is invalid.' };
        if (targetDoc?.storage?.provider === 'azure-blob' && overwrite) {
            await deleteWorkspaceBlob(targetDoc.storage);
        }
        await copyWorkspaceBlob(sourceDoc.storage, targetStorage);
        await deleteWorkspaceBlob(sourceDoc.storage);
        await workspaceMetadataStore.upsertWorkspaceFileRecord({
            workspaceId,
            sessionId: sourceDoc.sessionId || workspaceState.sessionId,
            folderName: sourceDoc.folderName || workspaceState.folderName || 'workspace',
            rootPath: '',
            sourceKind: WORKSPACE_SOURCE_UPLOAD,
            path: toPath,
            record: {
                ...sourceDoc,
                path: toPath,
                storage: targetStorage,
            },
            status: String(sourceDoc.status || 'completed').toLowerCase() === 'completed' ? 'completed' : 'pending',
        });
        await workspaceMetadataStore.deleteWorkspaceFileRecord(workspaceId, fromPath, {
            folderName: sourceDoc.folderName || workspaceState.folderName || 'workspace',
            rootPath: '',
            sourceKind: WORKSPACE_SOURCE_UPLOAD,
            sessionId: sourceDoc.sessionId || workspaceState.sessionId,
        });
        await syncUploadWorkspaceSummary(workspaceId, {
            folderName: sourceDoc.folderName || workspaceState.folderName || 'workspace',
            sessionId: sourceDoc.sessionId || workspaceState.sessionId,
        });
        return {
            ok: true,
            fromPath,
            toPath,
            overwritten: overwrite,
            updatedAt: workspaceState.indexedAt,
        };
    }
    if (!source) return { ok: false, error: 'Source file not found.' };
    if (workspaceState.files.has(toPath) && !overwrite) {
        return { ok: false, error: 'Target file already exists.' };
    }

    if (isLocalPathWorkspace()) {
        const sourceInfo = resolveLocalWorkspaceAbsolutePath(fromPath);
        const targetInfo = resolveLocalWorkspaceAbsolutePath(toPath);
        if (!overwrite) {
            try {
                await fs.promises.access(targetInfo.absolutePath, fs.constants.F_OK);
                return { ok: false, error: 'Target file already exists.' };
            } catch {
                // Target absent.
            }
        }
        await fs.promises.mkdir(path.dirname(targetInfo.absolutePath), { recursive: true });
        await fs.promises.rename(sourceInfo.absolutePath, targetInfo.absolutePath);
    } else if (source?.storage?.provider === 'azure-blob') {
        const targetStorage = workspaceUploadBlobStorageForPath(toPath);
        if (!targetStorage) {
            return { ok: false, error: 'Target blob path is invalid.' };
        }
        if (workspaceState.files.has(toPath) && overwrite) {
            const existingTarget = workspaceState.files.get(toPath);
            if (existingTarget?.storage?.provider === 'azure-blob') {
                await deleteWorkspaceBlob(existingTarget.storage);
            }
        }
        await copyWorkspaceBlob(source.storage, targetStorage);
        await deleteWorkspaceBlob(source.storage);
        source.storage = targetStorage;
    }

    workspaceState.files.delete(fromPath);
    workspaceState.files.set(toPath, { ...source, path: toPath });
    workspaceState.indexedAt = new Date().toISOString();
    persistWorkspaceState();

    return {
        ok: true,
        fromPath,
        toPath,
        overwritten: overwrite,
        updatedAt: workspaceState.indexedAt,
    };
}

async function deleteWorkspaceFile(data = {}) {
    const requested = ensureWorkspaceOwnedPath(data?.path, workspaceState.folderName || data?.folderName);
    if (!requested || requested.endsWith('/')) return { ok: false, error: 'Invalid file path.' };
    if (workspaceMetadataStore.enabled && isUploadWorkspace()) {
        const workspaceId = selectedWorkspaceId(data);
        const existing = await workspaceMetadataStore.getWorkspaceFile(workspaceId, requested);
        if (!existing) return { ok: false, error: 'File not found.' };
        if (existing.storage?.provider === 'azure-blob') {
            await deleteWorkspaceBlob(existing.storage);
        }
        await workspaceMetadataStore.deleteWorkspaceFileRecord(workspaceId, requested, {
            folderName: existing.folderName || workspaceState.folderName || 'workspace',
            rootPath: '',
            sourceKind: WORKSPACE_SOURCE_UPLOAD,
            sessionId: existing.sessionId || workspaceState.sessionId,
        });
        await syncUploadWorkspaceSummary(workspaceId, {
            folderName: existing.folderName || workspaceState.folderName || 'workspace',
            sessionId: existing.sessionId || workspaceState.sessionId,
        });
        return {
            ok: true,
            path: requested,
            deleted: true,
            updatedAt: workspaceState.indexedAt,
        };
    }
    if (!workspaceState.files.has(requested)) return { ok: false, error: 'File not found.' };

    if (isLocalPathWorkspace()) {
        const { absolutePath } = resolveLocalWorkspaceAbsolutePath(requested);
        await fs.promises.rm(absolutePath, { force: false });
    } else {
        const existing = workspaceState.files.get(requested);
        if (existing?.storage?.provider === 'azure-blob') {
            await deleteWorkspaceBlob(existing.storage);
        }
    }

    workspaceState.files.delete(requested);
    workspaceState.indexedAt = new Date().toISOString();
    persistWorkspaceState();

    return {
        ok: true,
        path: requested,
        deleted: true,
        updatedAt: workspaceState.indexedAt,
    };
}

async function applyWorkspaceBatch(data = {}) {
    const operations = Array.isArray(data?.operations) ? data.operations : [];
    const stopOnError = data?.stopOnError !== false;
    const results = [];

    for (const operation of operations) {
        const type = String(operation?.type || '').trim().toLowerCase();
        let result;

        if (type === 'write' || type === 'save') {
            result = await saveWorkspaceFile(operation);
        } else if (type === 'create') {
            result = await createWorkspaceFile(operation);
        } else if (type === 'rename') {
            result = await renameWorkspaceFile(operation);
        } else if (type === 'delete') {
            result = await deleteWorkspaceFile(operation);
        } else {
            result = { ok: false, error: `Unsupported batch operation "${type}".` };
        }

        results.push({ type, ok: result?.ok !== false, ...result });
        if (result?.ok === false && stopOnError) break;
    }

    return {
        ok: !results.some((entry) => entry.ok === false),
        results,
        appliedCount: results.filter((entry) => entry.ok !== false).length,
        failedCount: results.filter((entry) => entry.ok === false).length,
    };
}

async function gitStatusPayload() {
    const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout;
    const statusRaw = (await runGit(['status', '--porcelain=v1'])).stdout;
    const lines = statusRaw ? statusRaw.split('\n') : [];
    const staged = [];
    const unstaged = [];
    const untracked = [];

    for (const line of lines) {
        const x = line[0];
        const y = line[1];
        const file = workspacePathFromGitPath(line.slice(3).split(' -> ').pop());
        if (!file) continue;

        if (x === '?' && y === '?') {
            untracked.push(file);
            continue;
        }

        if (x !== ' ' && x !== '?') staged.push({ file, status: x });
        if (y !== ' ' && y !== '?') unstaged.push({ file, status: y });
    }

    let ahead = 0;
    let behind = 0;
    try {
        const counts = (await runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).stdout;
        const parts = counts.split(/\s+/);
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
    } catch {
        // Branch may not have an upstream yet.
    }

    return { ok: true, branch, staged, unstaged, untracked, ahead, behind };
}

async function resolveReferencedFiles(lastUserMessage) {
    const text = String(lastUserMessage || '').toLowerCase();
    const hasUploadWorkspace = workspaceMetadataStore.enabled && isUploadWorkspace();
    if (!text) return [];
    if (!hasUploadWorkspace && workspaceState.files.size === 0) return [];

    const compactText = text.replace(/[^a-z0-9]+/g, '');

    const matches = [];
    const candidates = hasUploadWorkspace
        ? await workspaceMetadataStore.listWorkspaceFiles(workspaceState.workspaceId)
        : sortedWorkspacePaths().map((path) => workspaceState.files.get(path));
    for (const candidate of candidates) {
        const path = toSafePath(candidate?.path || '');
        if (!path) continue;
        const meta = hasUploadWorkspace ? candidate : workspaceState.files.get(path);
        if (!workspaceRecordIndexed(meta)) continue;

        const base = basename(path).toLowerCase();
        const full = path.toLowerCase();
        const baseCompact = base.replace(/[^a-z0-9]+/g, '');
        const fullCompact = full.replace(/[^a-z0-9]+/g, '');

        if (
            text.includes(base) ||
            text.includes(full) ||
            (baseCompact && compactText.includes(baseCompact)) ||
            (fullCompact && compactText.includes(fullCompact))
        ) {
            matches.push(path);
        }
        if (matches.length >= 3) break;
    }

    const contexts = [];
    for (const path of matches) {
        const meta = hasUploadWorkspace
            ? await workspaceMetadataStore.getWorkspaceFile(workspaceState.workspaceId, path)
            : workspaceState.files.get(path);
        if (!meta) continue;
        const content = await loadWorkspaceRecordText(meta, path);
        contexts.push({
            path,
            excerpt: content.slice(0, 4000),
        });
    }

    return contexts;
}

function mockAssistantReply(lastUserMessage, fileContexts) {
    const prompt = String(lastUserMessage || '').toLowerCase();
    const totalFiles = workspaceMetadataStore.enabled && isUploadWorkspace()
        ? Number(workspaceState.fileCountTotal || workspaceState.files.size || 0)
        : workspaceState.files.size;
    const indexedFiles = workspaceMetadataStore.enabled && isUploadWorkspace()
        ? Number(workspaceState.fileCountCompleted || 0)
        : [...workspaceState.files.values()].filter((meta) => workspaceRecordIndexed(meta)).length;

    if (prompt.includes('ping')) {
        return 'pong (mesh tunnel)';
    }

    if (fileContexts.length > 0) {
        const fileList = fileContexts.map((f) => f.path).join(', ');
        return `I loaded these workspace files from the selected folder: ${fileList}. I can now review, explain, or refactor them in detail.`;
    }

    if (totalFiles > 0) {
        if (indexedFiles === 0) {
            return `Workspace "${workspaceState.folderName}" is connected. File tree is ready and content indexing is running in the background (0/${totalFiles} files ready).`;
        }
        return `Workspace "${workspaceState.folderName}" is indexing in the background (${indexedFiles}/${totalFiles} files ready). Mention a filename and I will inspect it.`;
    }

    return 'No workspace folder selected yet. Choose a folder in the AI tab, then ask me about specific files.';
}

function polishWorkerDisplayText(rawText) {
    let text = String(rawText || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (!text) return '';

    const looksLikeCode = /```|^\s*(const|let|var|function|class|import|export)\b/m.test(text);
    if (!looksLikeCode) {
        text = text.replace(/([.!?])([A-Za-z])/g, '$1 $2');
        text = text.replace(/(^|[.!?]\s+|\n+)([a-z])/g, (_m, prefix, first) => `${prefix}${first.toUpperCase()}`);
    }

    return text;
}

async function handleChat(data) {
    const model = String(data?.model || 'claude-sonnet-4-6');
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const lastUserMessage = messages.filter((m) => m?.role === 'user').at(-1)?.content || '';
    const referencedFiles = await resolveReferencedFiles(lastUserMessage);

    return {
        ok: true,
        model,
        content: polishWorkerDisplayText(mockAssistantReply(lastUserMessage, referencedFiles)),
        referencedFiles: referencedFiles.map((item) => item.path),
    };
}


export {
    compressWorkspaceChunkFiles,
    openLocalWorkspace,
    enqueueForIndexing,
    runIndexerForWorkspace,
    selectWorkspaceFolder,
    listWorkspaceFiles,
    getWorkspaceGraph,
    generateDependencyMapMarkdown,
    purgeWorkspace,
    enqueueWorkspaceEnrichment,
    drainWorkspaceEnrichmentQueue,
    enrichWorkspaceRecords,
    provisionMeshFolder,
    buildProjectJson,
    classifyFileRole,
    buildFilesMd,
    buildRulesMd,
    openWorkspaceFile,
    recoverWorkspaceSpans,
    saveWorkspaceFile,
    createWorkspaceFile,
    isTestPairOf,
    vectorBoost,
    hybridRankFiles,
    buildWorkspaceQueryContext,
    searchWorkspace,
    findMatchesInText,
    grepWorkspace,
    renameWorkspaceFile,
    deleteWorkspaceFile,
    applyWorkspaceBatch,
    gitStatusPayload,
    resolveReferencedFiles,
    mockAssistantReply,
    polishWorkerDisplayText,
    handleChat,
};
