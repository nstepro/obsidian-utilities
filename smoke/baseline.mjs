// Golden-baseline capture: runs each pipeline against the fixture vault and
// stores outputs under smoke/golden/. Never touches the real vault, GCS,
// Confluence, or installed apps.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inflateRawSync } from 'node:zlib';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const abs = (p) => path.join(root, p);
const fixtureVault = abs('smoke/fixture/vault');
const env = {
    ...process.env,
    BASE_MD_DIR: fixtureVault,
    GCS_BUCKET: 'test-bucket',
    GCS_MIGRATION: '',
    PDF_APP_PATH: '',
    WORD_APP_PATH: '',
    CONFLUENCE_HOST: '',
};
delete env.STORAGE_EMULATOR_HOST;

// A cold publish-state cache makes --dry-run call listExistingObjects(); the
// stub keeps that off the real GCS API. It MUST run as a separate process:
// spawnSync blocks this script's event loop, so an in-process server would
// never accept the child's connection and the child would hang.
const stubProc = spawn(process.execPath, [abs('smoke/gcs-stub-proc.mjs')], { encoding: 'utf8' });
const stubPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('GCS stub did not start')), 5000);
    stubProc.stdout.on('data', (d) => {
        const m = String(d).match(/PORT=(\d+)/);
        if (m) { clearTimeout(timer); resolve(+m[1]); }
    });
    stubProc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`GCS stub exited ${code}`)); });
});
env.STORAGE_EMULATOR_HOST = `http://127.0.0.1:${stubPort}`;

function run(cmd, args) {
    console.log(`+ node ${cmd} ${args.join(' ')}`);
    const res = spawnSync(process.execPath, [cmd, ...args], { cwd: root, env, encoding: 'utf8' });
    if (res.status !== 0) {
        console.error(res.stdout);
        console.error(res.stderr);
        throw new Error(`${cmd} exited ${res.status}`);
    }
    return res;
}

function place(src, dest) {
    fs.mkdirSync(path.dirname(abs(dest)), { recursive: true });
    fs.copyFileSync(abs(src), abs(dest));
    console.log(`  golden <- ${dest}`);
}

function unzipDocx(docxPath, member) {
    // Minimal ZIP local-file-header scan: good enough for the single member
    // we need (word/document.xml), avoiding an external unzip dependency.
    const buf = fs.readFileSync(abs(docxPath));
    const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    let pos = 0;
    while (pos < buf.length) {
        const i = buf.indexOf(sig, pos);
        if (i < 0) throw new Error('no zip local header found');
        const method = buf.readUInt16LE(i + 8);
        const compSize = buf.readUInt32LE(i + 18);
        const nameLen = buf.readUInt16LE(i + 26);
        const extraLen = buf.readUInt16LE(i + 28);
        const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
        const dataStart = i + 30 + nameLen + extraLen;
        if (name === member) {
            const raw = buf.subarray(dataStart, dataStart + compSize);
            const xml = method === 0 ? raw : inflateRawSync(raw);
            // html-to-docx names embedded media `image-${nanoid()}.<ext>` —
            // 21 random chars per run. Normalize them; everything else in
            // document.xml is compared byte-exactly.
            return xml.toString('utf8').replace(/image-[A-Za-z0-9_-]{21}/g, 'image-NORMALIZED');
        }
        pos = dataStart + compSize;
    }
    throw new Error(`${member} not found in ${docxPath}`);
}

fs.rmSync(abs('smoke/out'), { recursive: true, force: true });
fs.mkdirSync(abs('smoke/out'), { recursive: true });

// 1. GCS dry-run (fixture notes carry fixed guids; state file lands in the
//    disposable fixture vault). Stdout is captured as a normalized golden.
const gcs = run('publishToGCS.js', ['--dry-run']);
fs.writeFileSync(abs('smoke/golden/gcs-dry-run.txt'), gcs.stdout);

// 2. HTML golden via prettyPdf --save-html (PDF bytes are metadata-volatile;
//    page-count sanity only). prettyPdf opens the output with pdfAppPath which
//    is '' for the fixture: exec fails harmlessly after files are written.
run('prettyPdf.js', ['fixture', 'Base Note.md', '--save-html']);
place('smoke/out/Base Note.html', 'smoke/golden/pretty.html');

const pdfPath = abs('smoke/out/Base Note.pdf');
if (!fs.existsSync(pdfPath)) throw new Error('prettyPdf produced no PDF');
console.log(`  PDF produced (${fs.statSync(pdfPath).size} bytes; PDF content not golden-compared — only page/text sanity)`);

// 3. DOCX golden: html-to-docx embeds timestamps in the zip, so only
//    word/document.xml is compared.
run('prettyMsWord.js', ['fixture', 'Base Note.md']);
const docx = unzipDocx('smoke/out/Base Note.docx', 'word/document.xml');
fs.mkdirSync(abs('smoke/golden/word'), { recursive: true });
fs.writeFileSync(abs('smoke/golden/word/document.xml'), docx);

console.log('\nBaseline captured to smoke/golden/.');
stubProc.kill();
process.exit(0);
