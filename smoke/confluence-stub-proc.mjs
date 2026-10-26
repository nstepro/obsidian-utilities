// Standalone Confluence stub process: prints "PORT=<n>" then serves.
//   GET  /rest/api/content?...   -> { results: [] } (page not found)
//   POST /rest/api/content       -> { id: '1' }
//   GET  /_requests              -> captured request dump (control endpoint)
import http from 'node:http';

const requests = [];
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/_requests') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(requests));
        return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.method === 'GET' && req.url.startsWith('/rest/api/content')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [] })); // page does not exist -> create path
        } else if (req.method === 'POST' && req.url === '/rest/api/content') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: '1' }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'not found' } }));
        }
    });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
console.log(`PORT=${server.address().port}`);
process.on('SIGTERM', () => process.exit(0));
