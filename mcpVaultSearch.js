#!/usr/bin/env node
// Vault Search MCP — entry point. Runs the MCP stdio server; ALL logging to stderr.
import { loadMcpConfig } from './lib/mcp/config.js';
import { openStore } from './lib/mcp/store.js';
import { startServer } from './lib/mcp/server.js';

const log = (...args) => console.error('[vault-search]', ...args);

try {
    const config = loadMcpConfig(process.env);
    const db = openStore(config.dbPath);
    log(`vault: ${config.vaultPath} · db: ${config.dbPath} · model: ${config.ollamaModel}`);
    await startServer({ config, db, log });
} catch (err) {
    log('fatal:', err.message);
    process.exit(1);
}
