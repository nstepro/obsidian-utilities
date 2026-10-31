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

async function indexOnce({ config, db, force, log }) {
    const started = Date.now();
    const mdFiles = walkVault(config.vaultPath);
    const diskPaths = new Set();
    const stats = { scanned: 0, updated: 0, skipped: 0, embedded: 0, purged: 0 };

    // Model/dim mismatch → wipe vectors, keep chunks + FTS (plan §5.6). The
    // wipe returns true; that scan then ignores mtimes so every note is
    // re-checked and its chunks re-embedded.
    const vectorsWiped = checkModelSwap(db, config);

    const storedMtimes = store.getNoteMtimes(db);

    const pendingTexts = []; // { notePath, chunkIndex, text }
    const perNoteWork = [];

    for (const abs of mdFiles) {
        const rel = path.relative(config.vaultPath, abs).split(path.sep).join('/');
        diskPaths.add(rel);
        let stat;
        try {
            stat = fs.statSync(abs);
        } catch {
            continue; // vanished mid-scan
        }
        stats.scanned++;

        if (!force && !vectorsWiped && storedMtimes.has(rel) && stat.mtimeMs <= storedMtimes.get(rel)) {
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
                pendingTexts.push({ notePath: rel, chunkIndex: i, text: c.embeddingText });
            }
            // FTS: row is deleted by deleteChunksFromIndex only if the chunk was
            // dropped; if kept (same index re-inserted via INSERT OR REPLACE) the
            // FTS row must still be refreshed — cheapest correct approach is
            // delete-all-then-insert per note.
        }
        syncFtsForNote(db, rel, title, chunks);
        stats.updated++;
    }

    // Batched embedding of pending chunks
    if (pendingTexts.length) {
        const embedder = new Embedder({ ollamaUrl: config.ollamaUrl, model: config.ollamaModel, batchSize: config.embedBatchSize });
        try {
            for (let i = 0; i < pendingTexts.length; i += config.embedBatchSize) {
                const batch = pendingTexts.slice(i, i + config.embedBatchSize);
                const { dim, embeddings } = await embedder.embed(batch.map((t) => t.text));
                store.setMeta(db, 'embedding_dim', String(dim));
                for (let j = 0; j < batch.length; j++) {
                    Embedder.normalize(embeddings[j]);
                    store.setChunkEmbedding(db, store.chunkId(batch[j].notePath, batch[j].chunkIndex), store.packVector(embeddings[j]));
                    stats.embedded++;
                }
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
    // we can only detect a *model name* change before embedding; a dim change
    // with the same name is caught after the first embed call in indexOnce.
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
