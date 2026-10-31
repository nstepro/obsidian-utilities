import * as store from './store.js';

// Hybrid search: BM25 (FTS5) + cosine (brute force over pre-normalized
// Float32Array BLOBs) fused with Reciprocal Rank Fusion, k = 60.

const RRF_K = 60;

export async function search({ config, db, embedder, query, mode = 'hybrid', limit = 10, unique = 'notes' }) {
    const ftsRows = ftsSearch(db, query, mode === 'hybrid' || mode === 'fulltext' ? limit * 5 : 0);

    let cosineRows = [];
    let degraded = null;
    if (mode === 'hybrid' || mode === 'semantic') {
        try {
            const { dim, embeddings } = await embedder.embed([query]);
            const qv = EmbedderNormalize(embeddings[0]);
            cosineRows = cosineSearch(db, qv, dim, limit * 5);
        } catch (err) {
            if (mode === 'semantic') throw err;
            degraded = `semantic unavailable (${err.message}); fulltext only`;
        }
    }

    let hits;
    if (mode === 'fulltext') {
        hits = ftsRows.map((r) => ({ ...r, score: bm25Score(r.bm25) }));
        hits.sort((a, b) => b.score - a.score);
    } else {
        hits = rrfFuse(ftsRows, cosineRows);
    }

    let results = dedupe(hits, unique)
        .slice(0, limit)
        .map((h) =>
            shapeHit({
                notePath: h.notePath ?? h.note_path,
                chunkId: h.chunkId ?? h.chunk_id,
                title: h.title,
                content: h.content,
                heading: h.heading,
                startLine: h.startLine ?? h.start_line,
                endLine: h.endLine ?? h.end_line,
                score: h.score,
                degraded: h.degraded,
            }),
        );
    if (degraded) results = results.map((r) => ({ ...r, degraded }));
    return results;
}

// ---------- FTS5 side ----------

function ftsSearch(db, query, limit) {
    if (limit <= 0) return [];
    const expr = ftsExpr(query);
    if (!expr) return [];
    try {
        return db
            .prepare(
                `SELECT note_path, title, chunk_id, bm25(chunks_fts) AS bm25, content
         FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25 LIMIT ?`,
            )
            .all(expr, limit);
    } catch {
        return []; // malformed query (unbalanced quotes etc.) → no FTS hits
    }
}

// Build an OR-query so partial vocabulary still matches; quote every token.
function ftsExpr(query) {
    const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!tokens.length) return '';
    return tokens.map((t) => `"${t}"`).join(' OR ');
}

// bm25() in FTS5 returns smaller-is-better scores (usually negative). Map to a
// positive relevance for display: 1 / (1 + bm25 - minBm25).
function bm25Score(bm25) {
    return 1 / (1 + Math.max(0, bm25));
}

// ---------- cosine side ----------

function cosineSearch(db, queryVec, dim, limit) {
    const rows = db.prepare('SELECT id, note_path, chunk_index, heading, content, start_line, end_line, embedding FROM chunks WHERE embedding IS NOT NULL').all();
    const scored = [];
    for (const row of rows) {
        const v = store.unpackVector(row.embedding, dim);
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += queryVec[i] * v[i];
        scored.push({ ...row, cosine: dot });
    }
    scored.sort((a, b) => b.cosine - a.cosine);
    return scored.slice(0, limit);
}

function EmbedderNormalize(v) {
    // query vectors must be normalized the same way as indexed vectors
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
    const n = Math.sqrt(sum);
    if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
}

// ---------- RRF fusion ----------

export function rrfFuse(ftsRows, cosineRows) {
    const fused = new Map();
    const add = (key, rank, row, signal) => {
        let entry = fused.get(key);
        if (!entry) {
            entry = {
                notePath: row.note_path ?? row.notePath,
                chunkId: row.chunk_id ?? row.id,
                content: row.content,
                heading: row.heading,
                startLine: row.start_line ?? row.startLine,
                endLine: row.end_line ?? row.endLine,
                signals: {},
                score: 0,
            };
            fused.set(key, entry);
        }
        entry.signals[signal] = rank;
        entry.score += 1 / (RRF_K + rank);
    };
    ftsRows.forEach((row, i) => add(row.note_path + '::' + row.chunk_id, i + 1, row, 'bm25'));
    cosineRows.forEach((row, i) => add(row.note_path + '::' + row.id, i + 1, row, 'cosine'));
    const out = [...fused.values()];
    out.sort((a, b) => b.score - a.score);
    return out;
}

// ---------- shaping ----------

function dedupe(hits, unique) {
    if (unique !== 'notes') return hits;
    const seen = new Set();
    return hits.filter((h) => {
        const key = h.notePath ?? h.note_path;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function shapeHit(h) {
    const content = h.content ?? '';
    const excerpt = content.length > 200 ? content.slice(0, 200).trimEnd() + '…' : content;
    const out = {
        path: h.notePath,
        score: Number(h.score.toFixed(4)),
        excerpt,
    };
    if (h.title !== undefined) out.title = h.title; // fulltext path carries title
    if (h.heading) out.heading = h.heading;
    if (h.startLine !== undefined && h.startLine !== null) {
        out.startLine = h.startLine;
        out.endLine = h.endLine;
    }
    if (h.degraded) out.degraded = h.degraded;
    return out;
}
