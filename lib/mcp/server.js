import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadMcpConfig } from './config.js';
import { openStore, getMeta, countStats } from './store.js';
import { createIndexer } from './indexer.js';
import { Embedder, probeEmbedder } from './embedder.js';
import { search } from './search.js';

export async function startServer({ config, db, log }) {
    const indexer = createIndexer({ config, db, log });
    const embedder = new Embedder({ ollamaUrl: config.ollamaUrl, model: config.ollamaModel });
    const server = new McpServer({ name: 'vault-search', version: '1.0.0' });

    let lastScanAt = 0;

    const ensureFresh = async () => {
        if (Date.now() - lastScanAt < config.rescanIntervalMs) return;
        lastScanAt = Date.now();
        // background incremental scan; never blocks the search
        indexer.runIndex(false).catch((err) => log(`background rescan failed: ${err.message}`));
    };

    server.registerTool(
        'search',
        {
            title: 'Vault search',
            description:
                'Semantic + full-text hybrid search over the Obsidian vault. Falls back to full-text when the embedding backend is unavailable.',
            inputSchema: {
                query: z.string().describe('Search query (natural language or keywords)'),
                mode: z.enum(['hybrid', 'semantic', 'fulltext']).default('hybrid').describe('hybrid (default) fuses semantic and full-text ranks; semantic uses embeddings only; fulltext uses FTS only'),
                limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
                unique: z.enum(['notes', 'chunks']).default('notes').describe('Deduplicate per note (best chunk) or return raw chunk hits'),
            },
        },
        async ({ query, mode, limit, unique }) => {
            await ensureFresh();
            let results;
            try {
                if (mode === 'semantic') {
                    // must fail loudly when the embedding backend is unreachable
                    const probe = new Embedder({ ollamaUrl: config.ollamaUrl, model: config.ollamaModel });
                    await probe.embed(['probe']);
                }
                results = await search({ config, db, embedder, query, mode, limit, unique });
            } catch (err) {
                if (mode === 'semantic') {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ error: `semantic search unavailable: ${err.message}` }) }],
                        isError: true,
                    };
                }
                // hybrid failed at the semantic half → degrade to fulltext
                log(`search degraded to fulltext: ${err.message}`);
                results = await search({ config, db, embedder, query, mode: 'fulltext', limit, unique });
                results = results.map((r) => ({ ...r, degraded: `embedding backend unavailable (${err.message})` }));
            }
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        },
    );

    server.registerTool(
        'reindex',
        {
            title: 'Reindex vault',
            description: 'Incrementally re-index the vault now. force: true re-checks every file regardless of mtime (unchanged chunks still reuse stored embeddings).',
            inputSchema: {
                force: z.boolean().default(false).describe('Ignore mtime and re-check all files'),
            },
        },
        async ({ force }) => {
            const stats = await indexer.runIndex(force);
            lastScanAt = Date.now();
            return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
        },
    );

    server.registerTool(
        'index_status',
        {
            title: 'Index status',
            description: 'Report index health: model, dimensions, chunk/vector counts, last index time.',
            inputSchema: {},
        },
        async () => {
            const stats = countStats(db);
            const status = {
                embeddingModel: config.ollamaModel,
                embeddingDim: Number(getMeta(db, 'embedding_dim') ?? 0) || null,
                notesTotal: stats.notesTotal,
                chunksTotal: stats.chunksTotal,
                chunksWithVectors: stats.chunksWithVectors,
                pendingVectors: stats.pendingVectors,
                lastIndexedAt: Number(getMeta(db, 'last_indexed_at') ?? 0) || null,
                vaultPath: config.vaultPath,
                stale: Date.now() - (Number(getMeta(db, 'last_indexed_at') ?? 0) || 0) > config.rescanIntervalMs,
            };
            return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
        },
    );

    // Startup: probe Ollama, then kick off an initial incremental scan in the background —
    // but only when the index is actually stale (a fresh index needs no boot scan).
    try {
        const dim = await probeEmbedder(embedder);
        log(`ollama ready: ${config.ollamaModel} (${dim}d)`);
    } catch (err) {
        log(`ollama unavailable at startup (${err.message}); search will degrade to fulltext until it is reachable`);
    }
    lastScanAt = Date.now();
    const lastIndexedAt = Number(getMeta(db, 'last_indexed_at') ?? 0) || 0;
    if (Date.now() - lastIndexedAt > config.rescanIntervalMs) {
        indexer.runIndex(false).catch((err) => log(`startup scan failed: ${err.message}`));
    }

    await server.connect(new StdioServerTransport());
    log('vault-search MCP server connected on stdio');

    return { server };
}
