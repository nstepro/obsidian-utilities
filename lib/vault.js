import fs from 'node:fs';
import path from 'node:path';

// Async, Dirent-based, recursive file search; returns null when absent.
export async function findFileByName(directory, fileName) {
    let files;
    try {
        files = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (err) {
        throw err;
    }

    for (const file of files) {
        const filePath = path.join(directory, file.name);

        if (file.isDirectory()) {
            try {
                const foundPath = await findFileByName(filePath, fileName);
                if (foundPath) return foundPath;
            } catch (err) {
                console.error(err);
                continue;
            }
        } else if (file.name === fileName) {
            return filePath;
        }
    }

    return null;
}

// Recursively list .md files without reading them; skips vault-internal dirs
export function walkVault(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walkVault(p));
        else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
    }
    return out;
}
