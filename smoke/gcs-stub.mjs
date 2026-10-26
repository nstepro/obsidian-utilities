// Minimal GCS JSON-API stub for the smoke harness. Implements just enough of
// storage.googleapis.com/storage/v1/b/<bucket>/o (list) for
// publishToGCS.js --dry-run: a cold cache triggers listExistingObjects().
import http from 'node:http';

export async function startGcsStub() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://stub');
        // SDK requests /b/<bucket>/o under STORAGE_EMULATOR_HOST
        // (and /storage/v1/b/... in some configurations) — accept both.
        if (/^\/(storage\/v1\/)?b\/[^/]+\/o$/.test(url.pathname) && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ kind: 'storage#objects', items: [] }));
            return;
        }
        console.error(`STUB-MISS ${req.method} ${req.url}`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}
