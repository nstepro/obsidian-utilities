import * as store from './store.js';

// Hybrid search: BM25 (FTS5) + cosine (brute force over pre-normalized
// Float32Array BLOBs) fused with Reciprocal Rank Fusion, k = 60.

const RRF_K = 60;

export async function search({ config, db, embedder, query, mode = 'hybrid', limit = 10, unique = 'notes', pathPrefix, excludeTranscripts = false }) {
    const filter = { pathPrefix, excludeTranscripts };
    const ftsRows = ftsSearch(db, query, mode === 'hybrid' || mode === 'fulltext' ? limit * 5 : 0, filter);

    let cosineRows = [];
    let degraded = null;
    if (mode === 'hybrid' || mode === 'semantic') {
        try {
            const { dim, embeddings } = await embedder.embed([query]);
            const qv = EmbedderNormalize(embeddings[0]);
            cosineRows = cosineSearch(db, qv, dim, limit * 5, filter);
        } catch (err) {
            if (mode === 'semantic') throw err;
            degraded = `semantic unavailable (${err.message}); fulltext only`;
        }
    }

    let hits;
    if (mode === 'fulltext') {
        const top = ftsRows.length ? -ftsRows[0].bm25 : 0; // rows arrive best-first
        hits = ftsRows.map((r) => ({ ...r, score: bm25Score(r.bm25, top) }));
    } else {
        hits = rrfFuse(ftsRows, cosineRows);
    }

    const topHits = dedupe(hits, unique).slice(0, limit);
    const titles = store.getNoteTitles(db, topHits.map((h) => h.notePath ?? h.note_path));
    let results = topHits
        .map((h) =>
            shapeHit({
                notePath: h.notePath ?? h.note_path,
                chunkId: h.chunkId ?? h.chunk_id,
                title: h.title ?? titles.get(h.notePath ?? h.note_path),
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

// SQL fragment + params restricting a query to a folder prefix and/or excluding Granola transcripts.
// Applied inside the query (not on the top-k) so a filter never starves the result set.
function filterSql({ pathPrefix, excludeTranscripts }, col) {
    const sql = [];
    const params = [];
    if (pathPrefix) {
        sql.push(` AND substr(${col}, 1, ?) = ?`);
        params.push(pathPrefix.length, pathPrefix);
    }
    if (excludeTranscripts) sql.push(` AND ${col} NOT LIKE '%-transcript.md'`);
    return { sql: sql.join(''), params };
}

function ftsSearch(db, query, limit, filter) {
    if (limit <= 0) return [];
    const expr = ftsExpr(query);
    if (!expr) return [];
    const f = filterSql(filter, 'note_path');
    try {
        return db
            .prepare(
                `SELECT note_path, title, chunk_id, bm25(chunks_fts) AS bm25, content
         FROM chunks_fts WHERE chunks_fts MATCH ?${f.sql} ORDER BY bm25 LIMIT ?`,
            )
            .all(expr, ...f.params, limit);
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

// bm25() in FTS5 is negative, more negative = better. Map to a positive relevance (higher = better),
// normalised by the best hit so the top hit is 1.0. Comparable only within one fulltext result set,
// and not on the same scale as the RRF scores that hybrid/semantic modes return.
function bm25Score(bm25, top) {
    if (!(top > 0)) return 1;
    return Math.max(0, -bm25) / top;
}

// ---------- cosine side ----------

// All normalised vectors live in one contiguous Float32Array (id/path arrays alongside), rebuilt lazily
// when the store reports a change. Chunk text is fetched only for the final top-k. Memory is roughly
// chunks x dim x 4 bytes (~340 MB for 110k x 768). Brute force on purpose: no native deps (plan §2).
const vectorCaches = new WeakMap(); // db -> { version, dim, ids, paths, vectors }

function loadVectorCache(db, dim) {
    const version = store.vectorsVersion(db);
    const cached = vectorCaches.get(db);
    if (cached && cached.version === version && cached.dim === dim) return cached;
    const n = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get().n;
    const ids = new Array(n);
    const paths = new Array(n);
    const vectors = new Float32Array(n * dim);
    let i = 0;
    for (const row of db.prepare('SELECT id, note_path, embedding FROM chunks WHERE embedding IS NOT NULL').iterate()) {
        if (i >= n || row.embedding.byteLength !== dim * 4) continue; // raced a write / stale-dim vector
        ids[i] = row.id;
        paths[i] = row.note_path;
        vectors.set(store.unpackVector(row.embedding, dim), i * dim);
        i++;
    }
    const cache = { version, dim, count: i, ids, paths, vectors };
    vectorCaches.set(db, cache);
    return cache;
}

function cosineSearch(db, queryVec, dim, limit, { pathPrefix, excludeTranscripts } = {}) {
    const { count, ids, paths, vectors } = loadVectorCache(db, dim);
    const top = []; // [{ idx, cosine }] sorted descending, at most `limit` long
    for (let r = 0; r < count; r++) {
        const p = paths[r];
        if (pathPrefix && !p.startsWith(pathPrefix)) continue;
        if (excludeTranscripts && p.endsWith('-transcript.md')) continue;
        let dot = 0;
        const off = r * dim;
        for (let i = 0; i < dim; i++) dot += queryVec[i] * vectors[off + i];
        if (top.length === limit && dot <= top[limit - 1].cosine) continue;
        let pos = top.length;
        while (pos > 0 && top[pos - 1].cosine < dot) pos--;
        top.splice(pos, 0, { idx: r, cosine: dot });
        if (top.length > limit) top.pop();
    }
    if (!top.length) return [];
    const sel = db.prepare('SELECT id, note_path, chunk_index, heading, content, start_line, end_line FROM chunks WHERE id = ?');
    return top.map(({ idx, cosine }) => ({ ...sel.get(ids[idx]), cosine }));
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
    if (h.title !== undefined) out.title = h.title;
    if (h.heading) out.heading = h.heading;
    if (h.startLine !== undefined && h.startLine !== null) {
        out.startLine = h.startLine;
        out.endLine = h.endLine;
    }
    if (h.degraded) out.degraded = h.degraded;
    return out;
}
