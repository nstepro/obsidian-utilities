import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadMcpConfig(env = process.env) {
    const vaultPath = env.VAULT_PATH;
    if (!vaultPath) {
        throw new Error('VAULT_PATH is required (absolute path to the Obsidian vault)');
    }
    if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
        throw new Error(`VAULT_PATH is not a directory: ${vaultPath}`);
    }

    const rescanIntervalMs = Number(env.VSMCP_RESCAN_INTERVAL_MS ?? '30000');
    return {
        vaultPath: path.resolve(vaultPath),
        ollamaUrl: env.OLLAMA_URL ?? 'http://localhost:11434',
        ollamaModel: env.OLLAMA_MODEL ?? 'nomic-embed-text',
        dbPath: env.VSMCP_DB_PATH ?? path.join(repoRoot, '.data', 'vault-search.db'),
        rescanIntervalMs: Number.isFinite(rescanIntervalMs) && rescanIntervalMs > 0 ? rescanIntervalMs : 30000,
        embedBatchSize: 32,
    };
}
