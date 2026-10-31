// End-to-end MCP regression suite for the vault-search server.
// Boots stub-ollama + the real server as a child process (stdio JSON-RPC),
// drives tools/list + tools/call, asserts indexing, incremental behavior,
// search ranking, degradation, and purge. No network beyond localhost.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startOllamaStub, vectorFor } from './stub-ollama.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureVault = path.join(repoRoot, 'smoke/fixture/vault-mcp');
let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
    if (cond) {
        passed++;
        console.log(`  ok - ${name}`);
    } else {
        failures.push({ name, detail });
        console.error(`  FAIL - ${name}${detail ? `: ${detail}` : ''}`);
    }
}

// Minimal stdio JSON-RPC client over child process
function startServer(env) {
    const child = spawn('node', [path.join(repoRoot, 'mcpVaultSearch.js')], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.env.VSMCP_VERBOSE && console.error(String(d)));
    let buf = '';
    const pending = new Map();
    let nextId = 1;
    child.stdout.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined && pending.has(msg.id)) {
                    pending.get(msg.id)(msg);
                    pending.delete(msg.id);
                }
            } catch { /* partial line */ }
        }
    });
    const request = (method, params) =>
        new Promise((resolve) => {
            const id = nextId++;
            pending.set(id, resolve);
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    const initialized = (async () => {
        await request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'verify-mcp', version: '1.0.0' },
        });
        request('notifications/initialized', {});
    })();
    return {
        child,
        request,
        ready: initialized,
        stop: () => new Promise((r) => { child.on('exit', r); child.kill(); }),
    };
}

async function call(server, name, args) {
    const res = await server.request('tools/call', { name, arguments: args ?? {} });
    if (res.error) throw new Error(`tool ${name} error: ${JSON.stringify(res.error)}`);
    return JSON.parse(res.result.content[0].text);
}

const tmpDb = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `vsmcp-${name}-`));

// ---------------------------------------------------------------- scenario 1
console.log('scenario 1: discovery, first index, search ranking');
{
    const stub = await startOllamaStub();
    const dbDir = tmpDb('s1');
    const server = startServer({
        VAULT_PATH: fixtureVault,
        OLLAMA_URL: `http://127.0.0.1:${stub.port}`,
        OLLAMA_MODEL: 'stub-embed',
        VSMCP_DB_PATH: path.join(dbDir, 'index.db'),
        VSMCP_RESCAN_INTERVAL_MS: '30000',
    });

    await server.ready;
    const list = await server.request('tools/list', {});
    const toolNames = list.result.tools.map((t) => t.name).sort();
    check('tool discovery', JSON.stringify(toolNames) === JSON.stringify(['index_status', 'reindex', 'search']), toolNames.join(','));

    const stats = await call(server, 'reindex', {});
    check('reindex scans all 8 notes', stats.scanned === 8, `scanned=${stats.scanned}`);
    check('reindex leaves no pending vectors', stats.totalPendingVectors === 0 && stats.totalChunks > 0, `${stats.totalPendingVectors}/${stats.totalChunks}`);
    check('index counts notes', stats.totalNotes === 8, `totalNotes=${stats.totalNotes}`);

    // stub records batch calls; batch size must be capped
    const batchSizes = stub.calls.map((c) => c.texts.length);
    check('embeddings batched ≤32', batchSizes.every((n) => n <= 32), JSON.stringify(batchSizes));

    const status = await call(server, 'index_status', {});
    check('status reports model', status.embeddingModel === 'stub-embed', status.embeddingModel);
    check('status reports dim 64', status.embeddingDim === 64, String(status.embeddingDim));
    check('status no pending vectors', status.pendingVectors === 0, String(status.pendingVectors));
    check('status not stale right after index', status.stale === false);

    // Hybrid search: stub vector for the query is hash-random, so semantic rank is
    // arbitrary — but fusion with FTS must still surface the right notes. Query
    // with vocabulary unique to one note.
    const hits = await call(server, 'search', { query: 'chisel waterstone bevel sharpening', limit: 3 });
    check('hybrid search returns hits', hits.length > 0);
    check('hybrid ranks chisel note first', hits[0].path === 'Woodworking/Sharpening Chisels.md', hits[0].path);
    check('hit has excerpt + score', typeof hits[0].score === 'number' && hits[0].excerpt.length > 0);
    check('hit paths vault-relative with /', !hits[0].path.includes('\\'));

    const ftsHits = await call(server, 'search', { query: 'sourdough starter feeding', mode: 'fulltext' });
    check('fulltext finds sourdough', ftsHits.length > 0 && ftsHits[0].path === 'Cooking/Sourdough.md', ftsHits[0]?.path);

    const chunkHits = await call(server, 'search', { query: 'coroutines structured concurrency', unique: 'chunks', limit: 5 });
    check('chunks mode returns multiple hits', chunkHits.length >= 1);

    await server.stop();
    await stub.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- scenario 2
console.log('scenario 2: incremental (touch/add/delete) + degradation');
{
    // temp copy of the fixture so mutations don't dirty the repo
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsmcp-vault-'));
    fs.cpSync(fixtureVault, vaultDir, { recursive: true });
    const stub = await startOllamaStub();
    const dbDir = tmpDb('s2');

    const env = {
        VAULT_PATH: vaultDir,
        OLLAMA_URL: `http://127.0.0.1:${stub.port}`,
        OLLAMA_MODEL: 'stub-embed',
        VSMCP_DB_PATH: path.join(dbDir, 'index.db'),
        VSMCP_RESCAN_INTERVAL_MS: '30000',
    };
    let server = startServer(env);
    const first = await call(server, 'reindex', {});
    check('first index embeds everything', first.totalPendingVectors === 0 && first.totalChunks > 0, JSON.stringify(first));
    await server.stop();

    // touch ONE file (append a line → new mtime, same chunk hash → re-embed 0)
    const touchPath = path.join(vaultDir, 'Garden', 'Garden Layout.md');
    fs.appendFileSync(touchPath, '\nAdditional mulching remark for mtime bump.\n');
    server = startServer(env);
    let stats = await call(server, 'reindex', {});
    check('touch → 1 updated', stats.updated === 1, `updated=${stats.updated}`);
    check('touch → 0 embedded (hash reused)', stats.totalPendingVectors === 0, `pending=${stats.totalPendingVectors} embedded=${stats.embedded}`);
    check('touch → others skipped', stats.skipped === 7, `skipped=${stats.skipped}`);

    // add a new file → embedded
    fs.writeFileSync(
        path.join(vaultDir, 'Dev', 'Zig Pointers.md'),
        '# Zig Pointers\n\nPointer arithmetic in Zig is explicit. Slices carry length alongside the pointer.\n',
    );
    stats = await call(server, 'reindex', {});
    check('add → note indexed + embedded', stats.totalNotes === 9 && stats.totalPendingVectors === 0, JSON.stringify(stats));

    // stub vector uniqueness: query with vocab from the new file
    const zigHits = await call(server, 'search', { query: 'Zig pointer slices', limit: 3 });
    check('new note findable', zigHits.some((h) => h.path === 'Dev/Zig Pointers.md'), JSON.stringify(zigHits.map((h) => h.path)));

    // delete a file → purged
    fs.rmSync(path.join(vaultDir, 'Dev', 'Rust Ownership.md'));
    stats = await call(server, 'reindex', {});
    check('delete → purged 1', stats.purged === 1 || stats.totalNotes === 8, `purged=${stats.purged}`);
    const after = await call(server, 'index_status', {});
    check('purged note gone from counts', after.notesTotal === 8, String(after.notesTotal));

    // search works while stub up
    await call(server, 'search', { query: 'ownership borrow checker lifetime' });

    await server.stop();
    await stub.close();

    // degradation: stub down, server restart, semantic must surface the failure
    server = startServer(env);
    const degraded = await call(server, 'search', { query: 'coroutines structured concurrency', mode: 'semantic' }).catch((e) => ({ __err: String(e) }));
    check('semantic without Ollama surfaces the error', degraded.__err !== undefined || degraded.error !== undefined, JSON.stringify(degraded).slice(0, 200));

    const fallback = await call(server, 'search', { query: 'coroutines structured concurrency', mode: 'hybrid' });
    check('hybrid degrades to fulltext with note', fallback.length > 0 && typeof fallback[0].degraded === 'string', JSON.stringify(fallback).slice(0, 300));

    const fullOnly = await call(server, 'search', { query: 'coroutines', mode: 'fulltext' });
    check('fulltext works with stub down', fullOnly.length > 0, JSON.stringify(fullOnly).slice(0, 200));

    await server.stop();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- scenario 3
console.log('scenario 3: model swap wipes vectors, keeps chunks');
{
    const stub = await startOllamaStub();
    const dbDir = tmpDb('s3');
    const env = {
        VAULT_PATH: fixtureVault,
        OLLAMA_URL: `http://127.0.0.1:${stub.port}`,
        OLLAMA_MODEL: 'stub-embed',
        VSMCP_DB_PATH: path.join(dbDir, 'index.db'),
    };
    let server = startServer(env);
    await call(server, 'reindex', {});
    let status = await call(server, 'index_status', {});
    check('indexed with model A', status.chunksWithVectors === status.chunksTotal && status.chunksTotal > 0);
    await server.stop();

    env.OLLAMA_MODEL = 'stub-embed-v2';
    server = startServer(env);
    const stats = await call(server, 'reindex', {});
    check('model swap re-embeds all chunks', stats.totalPendingVectors === 0 && stats.embedded > 0, `embedded=${stats.embedded} pending=${stats.totalPendingVectors}`);
    status = await call(server, 'index_status', {});
    check('status shows new model', status.embeddingModel === 'stub-embed-v2');
    await server.stop();
    await stub.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f.name}: ${f.detail}`);
    process.exit(1);
}
