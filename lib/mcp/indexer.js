import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { walkVault } from '../vault.js';
import { chunkMarkdown, hashChunk } from './chunker.js';
import { Embedder } from './embedder.js';
import * as store from './store.js';

// Incremental indexer. A single instance serializes all index writes via the
// returned runIndex() queue (concurrent calls queue behind each other).

export function createIndexer({ config, db, log = () => {} }) {
    let queue = Promise.resolve();

    const runIndex = (force = false) => {
        const next = queue.then(() => indexOnce({ config, db, force, log }));
        queue = next.catch(() => {}); // swallow so the queue never rejects
        return next;
    };

    return { runIndex };
}

// Yield to the event loop so a large (OneDrive-hosted) vault can't starve the MCP stdio handshake.
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

async function indexOnce({ config, db, force, log }) {
    const started = Date.now();
    await yieldToLoop(); // let pending stdio (initialize) be handled before the sync directory walk
    const mdFiles = walkVault(config.vaultPath);
    const diskPaths = new Set();
    const stats = { scanned: 0, updated: 0, skipped: 0, embedded: 0, purged: 0 };

    // Model/dim mismatch → wipe vectors, keep chunks + FTS (plan §5.6). The
    // wipe returns true; that scan then ignores mtimes so every note is
    // re-checked and its chunks re-embedded.
    let vectorsWiped = checkModelSwap(db, config);
    if (!vectorsWiped && force && Number(store.getMeta(db, 'embedding_dim') ?? 0)) {
        // An explicit force reindex can reuse every stored vector (unchanged hashes) and never call the
        // embedder, so verify the dimension up front. If Ollama is unreachable, skip: the in-loop check covers it.
        try {
            const { dim } = await new Embedder({ ollamaUrl: config.ollamaUrl, model: config.ollamaModel }).embed(['dimension probe']);
            if (dim !== Number(store.getMeta(db, 'embedding_dim'))) {
                log(`embedding dimension changed -> ${dim}; wiping vectors`);
                store.clearAllEmbeddings(db);
                store.setMeta(db, 'embedding_dim', null);
                vectorsWiped = true;
            }
        } catch { /* backend down: nothing to compare against */ }
    }

    const storedMtimes = store.getNoteMtimes(db);
    // Notes with un-embedded chunks (Ollama was down / run interrupted) are never skipped,
    // so a plain incremental scan heals them; unchanged chunks still reuse stored vectors.
    const pendingNotes = store.getNotesWithPendingVectors(db);
    const failedHashes = store.getFailedHashes(db); // chunks Ollama already rejected: don't resend

    const pendingTexts = []; // { notePath, chunkIndex, text }
    const perNoteWork = [];

    for (const abs of mdFiles) {
        await yieldToLoop();
        const rel = path.relative(config.vaultPath, abs).split(path.sep).join('/');
        diskPaths.add(rel);
        let stat;
        try {
            stat = fs.statSync(abs);
        } catch {
            continue; // vanished mid-scan
        }
        stats.scanned++;

        if (!force && !vectorsWiped && storedMtimes.has(rel) && !pendingNotes.has(rel) && stat.mtimeMs <= storedMtimes.get(rel)) {
            stats.skipped++;
            continue;
        }

        const raw = fs.readFileSync(abs, 'utf8');
        const { data: frontmatter, content } = matter(raw);
        const title = typeof frontmatter.title === 'string' && frontmatter.title.trim() ? frontmatter.title.trim() : path.basename(rel, '.md');
        const chunks = chunkMarkdown(content);
        perNoteWork.push({ rel, title, mtime: stat.mtimeMs, chunks });
    }

    // Purge notes no longer on disk
    const stalePaths = [...storedMtimes.keys()].filter((p) => !diskPaths.has(p));
    stats.purged = store.purgeNotes(db, stalePaths);

    for (const { rel, title, mtime, chunks } of perNoteWork) {
        await yieldToLoop();
        store.inTransaction(db, () => {
        const existing = store.getChunksForNote(db, rel);
        const existingByHash = new Map(existing.map((c) => [c.content_hash, c]));
        const newIndices = new Set(chunks.map((_, i) => i));

        store.upsertNote(db, rel, title, mtime);
        store.deleteChunksFromIndex(db, rel, newIndices);

        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            const hash = hashChunk(c.embeddingText);
            const reuse = existingByHash.get(hash);
            if (reuse && reuse.embedding) {
                // unchanged chunk: carry the stored vector forward verbatim
                store.insertChunk(db, {
                    notePath: rel, index: i, heading: c.heading, content: c.content,
                    contentHash: hash, startLine: c.startLine, endLine: c.endLine,
                    embedding: reuse.embedding,
                });
            } else {
                store.insertChunk(db, {
                    notePath: rel, index: i, heading: c.heading, content: c.content,
                    contentHash: hash, startLine: c.startLine, endLine: c.endLine,
                    embedding: null,
                });
                if (!failedHashes.has(hash)) pendingTexts.push({ notePath: rel, chunkIndex: i, text: c.embeddingText, hash });
            }
            // FTS: row is deleted by deleteChunksFromIndex only if the chunk was
            // dropped; if kept (same index re-inserted via INSERT OR REPLACE) the
            // FTS row must still be refreshed — cheapest correct approach is
            // delete-all-then-insert per note.
        }
        syncFtsForNote(db, rel, title, chunks);
        });
        stats.updated++;
    }

    // Batched embedding of pending chunks
    if (pendingTexts.length) {
        const embedder = new Embedder({ ollamaUrl: config.ollamaUrl, model: config.ollamaModel, batchSize: config.embedBatchSize });
        try {
            for (let i = 0; i < pendingTexts.length; i += config.embedBatchSize) {
                const batch = pendingTexts.slice(i, i + config.embedBatchSize);
                const { dim, embeddings } = await embedResilient({ embedder, db, items: batch, log, stats });
                const storedDim = Number(store.getMeta(db, 'embedding_dim') ?? 0);
                if (dim && storedDim && dim !== storedDim) {
                    // same model name, different dimensionality: stored vectors are unusable. Wipe and redo everything.
                    log(`embedding dimension changed ${storedDim} -> ${dim}; wiping vectors and re-embedding`);
                    store.clearAllEmbeddings(db);
                    store.setMeta(db, 'embedding_dim', null);
                    return indexOnce({ config, db, force: true, log });
                }
                store.inTransaction(db, () => {
                    if (dim) store.setMeta(db, 'embedding_dim', String(dim));
                    for (let j = 0; j < batch.length; j++) {
                        if (!embeddings[j]) continue; // rejected chunk: stays un-embedded, recorded in embed_failures
                        Embedder.normalize(embeddings[j]);
                        store.setChunkEmbedding(db, store.chunkId(batch[j].notePath, batch[j].chunkIndex), store.packVector(embeddings[j]));
                        stats.embedded++;
                    }
                });
            }
            store.setMeta(db, 'last_indexed_at', String(Date.now()));
            store.setMeta(db, 'embedding_model', config.ollamaModel);
            store.setMeta(db, 'vault_path', config.vaultPath);
        } catch (err) {
            log(`embedding failed (partial index kept): ${err.message}`);
            store.setMeta(db, 'last_index_error', String(err.message));
        }
    } else {
        store.setMeta(db, 'last_indexed_at', String(Date.now()));
        store.setMeta(db, 'vault_path', config.vaultPath);
        if (perNoteWork.length || stats.purged) store.setMeta(db, 'embedding_model', config.ollamaModel);
    }

    log(`index done in ${Date.now() - started}ms: ${JSON.stringify(stats)}`);
    const totals = store.countStats(db);
    return { ...stats, totalNotes: totals.notesTotal, totalChunks: totals.chunksTotal, totalPendingVectors: totals.pendingVectors };
}

// Embed a batch. If Ollama rejects it outright (HTTP 400, e.g. NaN output or bad input), split it
// to isolate the offending chunk, retry that chunk once, then record and skip it so one bad chunk
// can't block everything behind it. Anything else (network error, 5xx) propagates and aborts the
// run, so an Ollama outage never marks healthy chunks as failed.
async function embedResilient({ embedder, db, items, log, stats }) {
    try {
        return await embedder.embed(items.map((t) => t.text));
    } catch (err) {
        if (err.status !== 400) throw err;
        if (items.length > 1) {
            const mid = items.length >> 1;
            const left = await embedResilient({ embedder, db, items: items.slice(0, mid), log, stats });
            const right = await embedResilient({ embedder, db, items: items.slice(mid), log, stats });
            return { dim: left.dim || right.dim, embeddings: [...left.embeddings, ...right.embeddings] };
        }
        const [item] = items;
        try {
            return await embedder.embed([item.text]); // one retry in case the rejection was transient
        } catch (err2) {
            if (err2.status !== 400) throw err2;
            store.recordEmbedFailure(db, { hash: item.hash, notePath: item.notePath, error: err2.message });
            stats.failed = (stats.failed ?? 0) + 1;
            log(`skipping chunk ${item.notePath}::${item.chunkIndex} (${item.text.length} chars): ${err2.message}`);
            return { dim: embedder.dim, embeddings: [null] };
        }
    }
}

function syncFtsForNote(db, notePath, title, chunks) {
    db.prepare('DELETE FROM chunks_fts WHERE note_path = ?').run(notePath);
    const ins = db.prepare('INSERT INTO chunks_fts (note_path, title, content, chunk_id) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < chunks.length; i++) {
        ins.run(notePath, title, chunks[i].content, store.chunkId(notePath, i));
    }
}

function checkModelSwap(db, config) {
    const storedModel = store.getMeta(db, 'embedding_model');
    const storedDim = store.getMeta(db, 'embedding_dim');
    // a model *name* change is detected here; a dim change under the same name is caught after the
    // first embed call in indexOnce.
    if (storedModel && storedModel !== config.ollamaModel) {
        store.clearAllEmbeddings(db);
        store.setMeta(db, 'embedding_model', config.ollamaModel);
        store.setMeta(db, 'embedding_dim', null);
        return true;
    }
    if (storedModel === null && storedDim === null) {
        store.setMeta(db, 'embedding_model', config.ollamaModel);
    }
    return false;
}
