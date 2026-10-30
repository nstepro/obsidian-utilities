// Deterministic Ollama /api/embed stub for the MCP smoke harness.
// Vectors are hash-derived per text (stable across runs, no network), so the
// same text always yields the same vector and different texts differ.
// Records every batch it receives for assertions.
import http from 'node:http';
import crypto from 'node:crypto';

export function vectorFor(text, dim = 64) {
    const v = new Float32Array(dim);
    let seed = crypto.createHash('sha256').update(text, 'utf8').digest();
    for (let i = 0; i < dim; i++) {
        v[i] = (seed[i % seed.length] / 255 - 0.5) * 2;
        if (i % seed.length === seed.length - 1 && i < dim - 1) {
            seed = crypto.createHash('sha256').update(seed).digest();
        }
    }
    // normalize
    let sum = 0;
    for (let i = 0; i < dim; i++) sum += v[i] * v[i];
    const n = Math.sqrt(sum) || 1;
    for (let i = 0; i < dim; i++) v[i] /= n;
    return Array.from(v);
}

export async function startOllamaStub({ dim = 64 } = {}) {
    const calls = []; // { texts: string[] }

    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/embed') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    const texts = Array.isArray(json.input) ? json.input : [String(json.input ?? '')];
                    calls.push({ texts });
                    const embeddings = texts.map((t) => vectorFor(t, dim));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ model: json.model, embeddings }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: String(err.message) }));
                }
            });
            return;
        }
        console.error(`STUB-MISS ${req.method} ${req.url}`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        calls,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

// CLI mode: `node smoke/stub-ollama.mjs` runs a standalone stub on :11434 fallback port 0.
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
    const stub = await startOllamaStub();
    console.log(`stub-ollama listening on ${stub.port}`);
}
