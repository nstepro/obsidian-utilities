import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = '1';

export function openStore(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
}

function migrate(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS notes (
      path TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mtime REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_note ON chunks(note_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
  `);
    db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      note_path UNINDEXED, title UNINDEXED, content,
      chunk_id UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);
    setMeta(db, 'schema_version', SCHEMA_VERSION);
}

// ---------- meta ----------

export function getMeta(db, key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

export function setMeta(db, key, value) {
    db.prepare(
        'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()',
    ).run(key, String(value));
}

// ---------- notes ----------

export function upsertNote(db, notePath, title, mtime) {
    db.prepare(
        'INSERT INTO notes (path, title, mtime) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET title = excluded.title, mtime = excluded.mtime',
    ).run(notePath, title, mtime);
}

export function getNoteMtimes(db) {
    return new Map(db.prepare('SELECT path, mtime FROM notes').all().map((r) => [r.path, r.mtime]));
}

export function purgeNotes(db, paths) {
    const del = db.prepare('DELETE FROM notes WHERE path = ?');
    const delFts = db.prepare('DELETE FROM chunks_fts WHERE note_path = ?');
    for (const p of paths) {
        delFts.run(p);
        del.run(p);
    }
    return paths.length;
}

// ---------- chunks ----------

export function chunkId(notePath, index) {
    return `${notePath}::${index}`;
}

export function getChunksForNote(db, notePath) {
    return db
        .prepare('SELECT id, chunk_index, content_hash, embedding FROM chunks WHERE note_path = ? ORDER BY chunk_index')
        .all(notePath);
}

export function deleteChunksFromIndex(db, notePath, keepIndices) {
    // removes chunks at indices >= new count or superseded; keeps FTS in sync
    const all = getChunksForNote(db, notePath);
    const del = db.prepare('DELETE FROM chunks WHERE id = ?');
    const delFts = db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?');
    let removed = 0;
    for (const c of all) {
        if (!keepIndices.has(c.chunk_index)) {
            delFts.run(c.id);
            del.run(c.id);
            removed++;
        }
    }
    return removed;
}

export function insertChunk(db, { notePath, index, heading, content, contentHash, startLine, endLine, embedding }) {
    db.prepare(
        'INSERT OR REPLACE INTO chunks (id, note_path, chunk_index, heading, content, content_hash, start_line, end_line, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(chunkId(notePath, index), notePath, index, heading, content, contentHash, startLine, endLine, embedding);
}

export function insertFtsRow(db, { notePath, title, content, chunkIndex }) {
    db.prepare('INSERT INTO chunks_fts (note_path, title, content, chunk_id) VALUES (?, ?, ?, ?)').run(
        notePath,
        title,
        content,
        chunkId(notePath, chunkIndex),
    );
}

// Embedding BLOB helpers: packed Float32Array, L2-normalized.

export function packVector(vec) {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function unpackVector(blob, dim) {
    return new Float32Array(blob.buffer, blob.byteOffset, dim);
}

export function setChunkEmbedding(db, id, blob) {
    db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(blob, id);
}

export function clearAllEmbeddings(db) {
    db.prepare('UPDATE chunks SET embedding = NULL').run();
}

export function countStats(db) {
    const notes = db.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    const withVectors = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get().n;
    return { notesTotal: notes, chunksTotal: chunks, chunksWithVectors: withVectors, pendingVectors: chunks - withVectors };
}

export function contentHash(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
