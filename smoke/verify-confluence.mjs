// publishToConfluence.js verification without live Confluence writes.
// Spins a stub Confluence REST API (separate process — spawnSync blocks this
// script's event loop, see baseline.mjs), runs the real pipeline against the
// fixture, and asserts request shape (auth header, title, editor body with the
// golden HTML and the img transforms).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const abs = (p) => path.join(root, p);

let failed = 0;
const fail = (msg) => { failed++; console.error(`FAIL: ${msg}`); };

const goldenHtml = fs.readFileSync(abs('smoke/golden/pretty.html'), 'utf8');

// What readMarkdown() produces: img tags get <br/> appended and max-width style
const expectedContent = goldenHtml
    .replace(/<img[^>]*>/g, '$&<br/>')
    .replace(/<img/g, '<img style="max-width: 500px;"');

const stubProc = spawn(process.execPath, [abs('smoke/confluence-stub-proc.mjs')], { encoding: 'utf8' });
let port = null;
stubProc.stdout.on('data', (d) => {
    const pm = String(d).match(/PORT=(\d+)/);
    if (pm && port === null) port = +pm[1];
});
const portReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Confluence stub did not start')), 5000);
    const iv = setInterval(() => { if (port) { clearInterval(iv); clearTimeout(timer); resolve(); } }, 30);
    stubProc.on('exit', (code) => { clearInterval(iv); clearTimeout(timer); reject(new Error(`Confluence stub exited ${code}`)); });
});
await portReady;

const res = spawnSync(process.execPath, ['publishToConfluence.js', 'fixture', 'Base Note.md'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: {
        ...process.env,
        CONFLUENCE_HOST: `http://127.0.0.1:${port}`,
        CONFLUENCE_USERNAME: 'smoke-user',
        CONFLUENCE_API_TOKEN: 'smoke-token',
        CONFLUENCE_DEFAULT_SPACE: 'SMK',
        CONFLUENCE_DEFAULT_PARENT: '42',
        PDF_APP_PATH: '',
    },
});

// Pull captured requests from the stub's control endpoint
const captured = await fetch(`http://127.0.0.1:${port}/_requests`).then((r) => r.json()).catch(() => null);
stubProc.kill();

if (res.status !== 0) {
    console.error(res.stdout);
    console.error(res.stderr);
    fail(`publishToConfluence.js exited ${res.status}`);
}

const requests = captured ?? [];
const auth = Buffer.from('smoke-user:smoke-token').toString('base64');

// 1. GET lookup with query params
const get = requests.find((r) => r.method === 'GET');
if (!get) {
    console.error('--- child stdout ---');
    console.error(res.stdout);
    console.error('--- child stderr ---');
    console.error(res.stderr);
    fail('no GET /rest/api/content request');
} else {
    const u = new URL(get.url, `http://127.0.0.1:${port}`);
    if (u.pathname !== '/rest/api/content') fail(`GET path ${u.pathname}`);
    if (u.searchParams.get('spaceKey') !== 'SMK') fail(`GET spaceKey=${u.searchParams.get('spaceKey')}`);
    if (u.searchParams.get('title') !== 'Base Note') fail(`GET title=${u.searchParams.get('title')}`);
    if (u.searchParams.get('expand') !== 'version') fail(`GET expand=${u.searchParams.get('expand')}`);
    if (get.headers.authorization !== `Basic ${auth}`) fail('GET Authorization header missing/wrong');
    else console.log('OK: GET content lookup (params + basic auth)');
}

// 2. POST create with editor body
const post = requests.find((r) => r.method === 'POST');
if (!post) {
    fail('no POST /rest/api/content request');
} else {
    let data;
    try {
        data = JSON.parse(post.body);
    } catch (e) {
        fail('POST body is not JSON: ' + e.message);
        data = null;
    }
    if (data) {
        if (post.headers.authorization !== `Basic ${auth}`) fail('POST Authorization header missing/wrong');
        if (data.type !== 'page') fail(`POST type=${data.type}`);
        if (data.title !== 'Base Note') fail(`POST title=${data.title}`);
        if (data.space?.key !== 'SMK') fail(`POST space.key=${data.space?.key}`);
        if (!Array.isArray(data.ancestors) || data.ancestors[0]?.id !== '42') fail('POST ancestors missing or wrong id');
        if (data.body?.editor?.representation !== 'editor') fail(`POST representation=${data.body?.editor?.representation}`);
        const value = data.body?.editor?.value ?? '';
        if (value !== expectedContent) {
            // show first divergence
            const n = Math.min(value.length, expectedContent.length);
            let d = 0;
            while (d < n && value[d] === expectedContent[d]) d++;
            fail(`POST editor.value differs at char ${d}: expected ${JSON.stringify(expectedContent.slice(d, d + 80))}, got ${JSON.stringify(value.slice(d, d + 80))}`);
        } else {
            console.log('OK: POST create page (title, space, ancestors, editor body incl. img transforms + golden HTML)');
        }
    }
}

if (failed) {
    console.error(`\nverify-confluence: ${failed} check(s) FAILED`);
    process.exit(1);
}
console.log('\nverify-confluence: all checks passed');
