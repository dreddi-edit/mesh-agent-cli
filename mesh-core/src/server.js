/**
 * MESH Worker — Express server with route handlers.
 * State and constants live in mesh-state.js.
 * Helper utilities live in workspace-helpers.js.
 * Workspace/chat operations live in workspace-operations.js.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { compressMeshPayload, decompressMeshPayload } from './MeshServer.js';
import { logger } from './logger.js';

import {
    workspaceState,
} from './mesh-state.js';

import {
    normalizeWorkspaceSourceKind,
    restoreWorkspaceState,
    ensureWorkspaceOwnedPath,
    isLocalPathWorkspace,
    resolveLocalWorkspaceAbsolutePath,
    gitPathFromWorkspacePath,
    workspacePathFromGitPath,
    readLocalWorkspaceFileText,
    getGitCwd,
    runGit,
} from './workspace-helpers.js';

import {
    openLocalWorkspace,
    selectWorkspaceFolder,
    listWorkspaceFiles,
    getWorkspaceGraph,
    purgeWorkspace,
    openWorkspaceFile,
    recoverWorkspaceSpans,
    createWorkspaceFile,
    saveWorkspaceFile,
    searchWorkspace,
    grepWorkspace,
    renameWorkspaceFile,
    deleteWorkspaceFile,
    applyWorkspaceBatch,
    gitStatusPayload,
    handleChat,
} from './workspace-operations.js';

const app = express();

app.use(express.raw({ type: 'application/octet-stream', limit: '200mb' }));
app.use(express.json({ limit: '200mb' }));

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

app.post('/mesh/tunnel', async (req, res) => {
    const requestId = req.headers['x-request-id'] || null;
    const reqLogger = logger.child(requestId);

    const workerSecret = process.env.MESH_WORKER_SECRET;
    if (workerSecret && req.headers['x-mesh-worker-secret'] !== workerSecret) {
        reqLogger.warn('Unauthorized tunnel request blocked');
        return res.status(401).json({ ok: false, error: 'Unauthorized: Missing or invalid worker secret.' });
    }

    try {
        const envelope = await parseMeshEnvelope(req);
        const action = String(envelope?.action || '');
        const data = envelope?.data || {};

        reqLogger.info('Mesh tunnel request', { action });

        let payload;
        if (action === 'status') {
            payload = {
                ok: true,
                mode: 'mesh-worker',
                workspaceSelected: Boolean(workspaceState.folderName || workspaceState.workspaceId),
                workspaceFileCount: Number(workspaceState.fileCountTotal || workspaceState.files.size || 0),
                rootPath: workspaceState.rootPath || '',
                workspaceId: workspaceState.workspaceId || '',
                sessionId: workspaceState.sessionId || '',
                sourceKind: normalizeWorkspaceSourceKind(workspaceState.sourceKind),
                workspaceStatus: String(workspaceState.status || ''),
                fileCountCompleted: Number(workspaceState.fileCountCompleted || 0),
                fileCountPending: Number(workspaceState.fileCountPending || 0),
                fileCountFailed: Number(workspaceState.fileCountFailed || 0),
            };
        } else if (action === 'workspace.open-local') {
            payload = await openLocalWorkspace(data);
        } else if (action === 'workspace.select') {
            payload = await selectWorkspaceFolder(data);
        } else if (action === 'workspace.files') {
            payload = await listWorkspaceFiles(data);
        } else if (action === 'workspace.graph') {
            payload = await getWorkspaceGraph(data);
        } else if (action === 'workspace.purge') {
            payload = await purgeWorkspace(data);
        } else if (action === 'workspace.file.open') {
            payload = await openWorkspaceFile(data);
        } else if (action === 'workspace.capsule.open') {
            payload = await openWorkspaceFile({ ...data, view: 'capsule' });
        } else if (action === 'workspace.transport.open') {
            payload = await openWorkspaceFile({ ...data, view: 'transport' });
        } else if (action === 'workspace.recovery.fetch') {
            payload = await recoverWorkspaceSpans(data);
        } else if (action === 'workspace.index.stats') {
            payload = await listWorkspaceFiles(data);
        } else if (action === 'workspace.file.create') {
            payload = await createWorkspaceFile(data);
        } else if (action === 'workspace.file.save') {
            payload = await saveWorkspaceFile(data);
        } else if (action === 'workspace.search') {
            payload = await searchWorkspace(data);
        } else if (action === 'workspace.grep') {
            payload = await grepWorkspace(data);
        } else if (action === 'workspace.file.rename') {
            payload = await renameWorkspaceFile(data);
        } else if (action === 'workspace.file.delete') {
            payload = await deleteWorkspaceFile(data);
        } else if (action === 'workspace.batch') {
            payload = await applyWorkspaceBatch(data);
        } else if (action === 'git.status') {
            payload = await gitStatusPayload();
        } else if (action === 'git.branches') {
            const raw = (await runGit(['branch', '-a', '--format=%(refname:short)\t%(HEAD)'])).stdout;
            const lines = raw ? raw.split('\n') : [];
            const branches = [];
            let current = '';
            for (const line of lines) {
                const [name, head] = line.split('\t');
                if (!name) continue;
                branches.push(name);
                if (head === '*') current = name;
            }
            if (!current) {
                try {
                    current = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout;
                } catch {
                    current = '';
                }
            }
            payload = { ok: true, branches, current };
        } else if (action === 'git.checkout') {
            const branch = String(data?.branch || '').trim();
            if (!branch) {
                payload = { ok: false, error: 'Branch name required' };
            } else {
                await runGit(['checkout', branch]);
                payload = { ok: true, branch };
            }
        } else if (action === 'git.stage') {
            const files = Array.isArray(data?.files) && data.files.length
                ? data.files.map((file) => gitPathFromWorkspacePath(file)).filter(Boolean)
                : ['.'];
            await runGit(['add', ...files]);
            payload = { ok: true };
        } else if (action === 'git.unstage') {
            const files = Array.isArray(data?.files) && data.files.length
                ? data.files.map((file) => gitPathFromWorkspacePath(file)).filter(Boolean)
                : ['.'];
            await runGit(['reset', 'HEAD', '--', ...files]);
            payload = { ok: true };
        } else if (action === 'git.commit') {
            const message = String(data?.message || '').trim();
            if (!message) {
                payload = { ok: false, error: 'Commit message required' };
            } else {
                if (Array.isArray(data?.files) && data.files.length) {
                    const files = data.files.map((file) => gitPathFromWorkspacePath(file)).filter(Boolean);
                    if (files.length) await runGit(['add', ...files]);
                }
                const result = await runGit(['commit', '-m', message]);
                payload = { ok: true, output: result.stdout || result.stderr };
            }
        } else if (action === 'git.push') {
            const result = await runGit(['push']);
            payload = { ok: true, output: result.stdout || result.stderr };
        } else if (action === 'git.pull') {
            const result = await runGit(['pull']);
            payload = { ok: true, output: result.stdout || result.stderr };
        } else if (action === 'git.diff') {
            const diffPath = gitPathFromWorkspacePath(data?.path);
            const diffArgs = ['diff'];
            if (diffPath) diffArgs.push('--', diffPath);
            const stagedArgs = ['diff', '--cached'];
            if (diffPath) stagedArgs.push('--', diffPath);
            const result = await runGit(diffArgs);
            const staged = await runGit(stagedArgs);
            let beforeContent = '';
            let afterContent = '';
            if (diffPath) {
                try {
                    beforeContent = (await runGit(['show', `HEAD:${diffPath}`])).stdout;
                } catch {
                    beforeContent = '';
                }
                try {
                    const workspacePath = workspacePathFromGitPath(diffPath) || ensureWorkspaceOwnedPath(data?.path, workspaceState.folderName || '');
                    if (workspacePath) {
                        const target = resolveLocalWorkspaceAbsolutePath(workspacePath);
                        afterContent = await readLocalWorkspaceFileText(target.absolutePath);
                    }
                } catch {
                    afterContent = '';
                }
            }
            payload = { ok: true, diff: result.stdout, stagedDiff: staged.stdout, beforeContent, afterContent };
        } else if (action === 'git.log') {
            const limit = Math.min(parseInt(data?.limit, 10) || 20, 100);
            const result = await runGit(['log', `--max-count=${limit}`, '--format=%H\t%an\t%ae\t%aI\t%s']);
            const commits = (result.stdout ? result.stdout.split('\n') : []).filter(Boolean).map((line) => {
                const [hash, author, email, date, ...messageParts] = line.split('\t');
                return { hash, author, email, date, message: messageParts.join('\t') };
            });
            payload = { ok: true, commits };
        } else if (action === 'git.stash') {
            const stashAction = String(data?.action || 'push').trim().toLowerCase();
            if (stashAction === 'list') {
                const result = await runGit(['stash', 'list']);
                payload = { ok: true, stashes: result.stdout ? result.stdout.split('\n') : [] };
            } else if (stashAction === 'pop') {
                const result = await runGit(['stash', 'pop']);
                payload = { ok: true, output: result.stdout || result.stderr };
            } else {
                const result = await runGit(['stash', 'push', '-m', String(data?.message || 'Mesh stash')]);
                payload = { ok: true, output: result.stdout || result.stderr };
            }
        } else if (action === 'git.clone') {
            const url = String(data?.url || '').trim();
            if (!url) {
                payload = { ok: false, error: 'Repository URL required' };
            } else {
                const explicitTarget = String(data?.path || '').trim();
                if (!explicitTarget && !isLocalPathWorkspace()) {
                    payload = { ok: false, error: 'Target path required when no local workspace root is configured.' };
                } else {
                    const fallbackName = url.split('/').pop()?.replace(/\.git$/i, '') || 'repo';
                    const targetPath = explicitTarget
                        ? path.resolve(explicitTarget)
                        : path.resolve(path.dirname(getGitCwd()), fallbackName);
                    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
                    const result = await runGit(['clone', url, targetPath], path.dirname(targetPath));
                    payload = {
                        ok: true,
                        path: targetPath,
                        folderName: path.basename(targetPath),
                        output: result.stderr || result.stdout,
                    };
                }
            }
        } else if (action === 'git.init') {
            const result = await runGit(['init']);
            payload = { ok: true, output: result.stdout || result.stderr };
        } else if (action === 'git.create-branch') {
            const name = String(data?.name || '').trim();
            if (!name) {
                payload = { ok: false, error: 'Branch name required' };
            } else {
                const args = ['checkout', '-b', name];
                if (data?.startPoint) args.push(String(data.startPoint));
                await runGit(args);
                payload = { ok: true, branch: name };
            }
        } else if (action === 'git.delete-branch') {
            const name = String(data?.name || '').trim();
            if (!name) {
                payload = { ok: false, error: 'Branch name required' };
            } else {
                await runGit(['branch', '-d', name]);
                payload = { ok: true };
            }
        } else if (action === 'chat') {
            payload = await handleChat(data);
        } else {
            payload = { ok: false, error: `Unknown mesh action: ${action}` };
        }

        await sendCompressedJson(res, payload, payload.ok === false ? 400 : 200);
    } catch (error) {
        reqLogger.error('Mesh tunnel request failed', { error: error.message, stack: error.stack });
        await sendCompressedJson(res, { ok: false, error: error.message || 'Mesh request failed' }, 500);
    }
});

// Legacy compatibility route used by earlier frontend wiring.
app.post('/api/chat/mesh', async (req, res) => {
    try {
        const incoming = await parseMeshEnvelope(req);
        const payload = await handleChat(incoming);
        await sendCompressedJson(res, payload, 200);
    } catch (error) {
        await sendCompressedJson(res, { ok: false, error: error.message || 'Legacy mesh route failed' }, 500);
    }
});

const port = process.env.PORT || 8080;
restoreWorkspaceState();
app.listen(port, () => {
    logger.info('Mesh tunnel server started', { port });
});
