// Regression gate: re-runs the pipelines against the fixture and diffs
// against the goldens in smoke/golden/.
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
    PDF_APP_PATH: '',
    WORD_APP_PATH: '',
    CONFLUENCE_HOST: '',
};
delete env.STORAGE_EMULATOR_HOST;

// publishToGCS --dry-run may call listExistingObjects() (cold cache); stub it.
// Separate process — spawnSync blocks this script's event loop (see baseline.mjs).
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

let failed = 0;
function fail(msg) {
    failed++;
    console.error(`FAIL: ${msg}`);
}

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

function unzipDocx(docxPath, member) {
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
            // normalize like baseline.mjs does.
            return xml.toString('utf8').replace(/image-[A-Za-z0-9_-]{21}/g, 'image-NORMALIZED');
        }
        pos = dataStart + compSize;
    }
    throw new Error(`${member} not found in ${docxPath}`);
}

// Lines that legitimately vary between runs: mtime-based "Processing" lines
// and state-file related output. Upload plan lines (key, size, content-type)
// must match exactly and are compared verbatim.
function normalizeGcsStdout(stdout) {
    return stdout
        .split(/\r?\n/)
        .filter((l) => !/^Processing modified file:/.test(l) && !/^\[dry-run\] upload gs:\/\/test-bucket\/grimace\/images\//.test(l))
        .join('\n');
}

function diffText(label, goldenPath, actualText) {
    const goldenText = fs.readFileSync(abs(goldenPath), 'utf8');
    if (goldenText === actualText) {
        console.log(`OK: ${label} matches golden`);
        return true;
    }
    fail(`${label} differs from ${goldenPath}`);
    if (goldenText.length !== actualText.length) console.error(`  length: golden=${goldenText.length} actual=${actualText.length}`);
    const n = Math.min(goldenText.length, actualText.length);
    for (let i = 0; i < n; i++) {
        if (goldenText[i] !== actualText[i]) {
            console.error(`  first diff at char ${i}:`);
            console.error(`   golden: ${JSON.stringify(goldenText.slice(Math.max(0, i - 60), i + 60))}`);
            console.error(`   actual: ${JSON.stringify(actualText.slice(Math.max(0, i - 60), i + 60))}`);
            break;
        }
    }
    return false;
}

function diff(label, goldenPath, actualBuf) {    const golden = fs.readFileSync(abs(goldenPath));
    if (golden.equals(actualBuf)) {
        console.log(`OK: ${label} matches golden`);
        return true;
    }
    fail(`${label} differs from ${goldenPath}`);
    if (golden.length !== actualBuf.length) console.error(`  length: golden=${golden.length} actual=${actualBuf.length}`);
    // show first differing offset
    const n = Math.min(golden.length, actualBuf.length);
    for (let i = 0; i < n; i++) {
        if (golden[i] !== actualBuf[i]) {
            console.error(`  first diff at byte ${i}:`);
            console.error(`   golden: ${JSON.stringify(golden.subarray(Math.max(0, i - 60), i + 60).toString('utf8'))}`);
            console.error(`   actual: ${JSON.stringify(actualBuf.subarray(Math.max(0, i - 60), i + 60).toString('utf8'))}`);
            break;
        }
    }
    return false;
}

fs.rmSync(abs('smoke/out'), { recursive: true, force: true });
fs.mkdirSync(abs('smoke/out'), { recursive: true });

// 1. GCS dry-run
const gcs = run('publishToGCS.js', ['--dry-run']);
const goldenGcs = fs.readFileSync(abs('smoke/golden/gcs-dry-run.txt'), 'utf8');
if (normalizeGcsStdout(gcs.stdout) === normalizeGcsStdout(goldenGcs)) {
    console.log('OK: GCS dry-run stdout matches golden');
} else {
    fail('GCS dry-run stdout differs');
    console.error(`--- golden ---\n${goldenGcs}\n--- actual ---\n${gcs.stdout}`);
}

// 2. HTML golden
run('prettyPdf.js', ['fixture', 'Base Note.md', '--save-html']);
diff('pretty.html', 'smoke/golden/pretty.html', fs.readFileSync(abs('smoke/out/Base Note.html')));

const pdfPath = abs('smoke/out/Base Note.pdf');
if (!fs.existsSync(pdfPath)) fail('prettyPdf produced no PDF');

// 3. DOCX golden (word/document.xml only, nanoid-normalized)
run('prettyMsWord.js', ['fixture', 'Base Note.md']);
const docxXml = unzipDocx('smoke/out/Base Note.docx', 'word/document.xml');
diffText('word/document.xml', 'smoke/golden/word/document.xml', docxXml);

if (failed) {
    console.error(`\nverify: ${failed} check(s) FAILED`);
    stubProc.kill();
    process.exit(1);
} else {
    console.log('\nverify: all checks passed');
    stubProc.kill();
    process.exit(0);
}
