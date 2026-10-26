# Refactor Execution Plan — Obsidian Utilities

Written for an executing agent. Follow stages in order; do not skip verification gates. Each stage ends with a gate that MUST pass before continuing. If a gate fails, fix the regression before proceeding; if unfixable in one attempt, stop and report.

## Repo facts (verified 2026-10-26)

- Working dir: `C:/Users/NICHO/git/obsidian-utilities`, Node v24.22.1 (already includes the brotli fix), npm 11.19.1.
- Entry scripts: `prettyPdf.js`, `prettyMsWord.js`, `publishToConfluence.js`, `publishToGCS.js`. Shared: `markdownToHTML.js`, `cssMappings.js`. Configs: `configs/arcMain.json`, `configs/ns.json`. Templates: `templates/arcMain/`, `templates/ns/` (each: `body.html`, `footer.html`, `header.html`, `msword.json`, `style.scss`).
- No code has been changed yet for this refactor. No baseline commit exists yet — Stage 0 creates it.
- CVE context: Node.js security release of 2026-10-21 (v22.23.4, v24.22.1, v26.12.1) fixed CVE-2026-111497 (brotli decoder out-of-bounds write, high) among others. Local Node v24.22.1 is already patched; the plan pins the floor so no other machine regresses.

## Target dependency set

Final `package.json` (17 deps → 10):

```json
{
  "name": "obsidian-utilities",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.22.1" },
  "scripts": {
    "baseline": "node smoke/baseline.mjs",
    "verify": "node smoke/verify.mjs"
  },
  "dependencies": {
    "@google-cloud/storage": "^8.4.0",
    "commonmark": "^0.31.2",
    "dotenv": "^18.0.9",
    "glob": "^13.0.6",
    "gray-matter": "^4.0.3",
    "html-to-docx": "^1.8.0",
    "jimp": "^1.6.1",
    "marked": "^18.1.1",
    "puppeteer": "^25.16.0",
    "sass": "^1.106.1"
  }
}
```

Removed (verified never imported, or trivially replaced): `obsidian`, `html-docx-js`, `confluence.js`, `moment`, `fs-extra`, `axios`, `short-uuid`.

## Target file layout

```text
prettyPdf.js            entry, unchanged CLI: node prettyPdf.js [config] [file] [--save-html|--html]
prettyMsWord.js         entry, unchanged CLI: node prettyMsWord.js [config] [file]
publishToConfluence.js entry, unchanged CLI: node publishToConfluence.js [config] [file]
publishToGCS.js         entry, unchanged CLI: node publishToGCS.js [--dry-run] [--refresh]
lib/config.js           dotenv + argv parsing + configs/*.json loading + path derivation
lib/vault.js            findFileByName(), walkVault()
lib/frontmatter.js      parse/stringify wrappers + hasPublishKey()
lib/open.js             openInApp(filePath, appPath)  (spawn + detached + unref)
lib/markdownToHTML.js   moved from ./markdownToHTML.js, updated for marked 18 + jimp 1
lib/cssMappings.js      moved from ./cssMappings.js, unchanged content
smoke/baseline.mjs     captures golden outputs to smoke/golden/
smoke/verify.mjs       re-runs pipelines, diffs against smoke/golden/
smoke/fixture/         synthetic vault + template + config used by the harness
```

CLI contracts are UNCHANGED — the README documents Obsidian Shell Commands integration that calls `node prettyPdf.js arcMain "{{file_name}}"`; entry scripts stay in repo root with identical arguments.

---

## Stage 0 — Golden-baseline harness (before any code change)

Purpose: prove later stages byte-identical output. Uses a synthetic fixture vault so it never touches the user's real vault, GCS, Confluence, or installed apps.

### 0.1 Build fixture

`smoke/fixture/` (all files listed; create exactly):

- `vault/Base Note.md` — frontmatter with `title` plus flat css keys (`cssImageMaxWidth: "500px"`, `cssH1Color: "#2c3e50"`), an Obsidian embed `![[fixture-image.png]]`, one `h1`, two `h2` sections, a `---page---` marker, a `#hashtag`, a link `[[Linked Note]]`, a nested `css:` block variant note as second fixture `vault/Nested Note.md`.
- `vault/99 - Images & Assets/fixture-image.png` — generate a >2000px-wide PNG (draw with jimp 0.22 while still installed, or a pre-made PNG committed to the fixture).
- `vault/99 - Images & Assets/fixture-wide.jpg` — >2000px JPEG, to exercise the JPEG/quality branch in `imageToBase64`.
- `vault/Linked Note.md` — plain note (for `[[Linked Note]]` resolution in GCS dry-run).
- `smoke/fixture/template/body.html`, `header.html`, `footer.html`, `msword.json`, `style.scss` — copy structure from `templates/arcMain/` and adapt: header contains `{title}` token, footer contains `{year}` token, body contains `{css}` and `{html}` tokens (verify against real templates' exact token usage; the code replaces `{css}`, `{html}`, `{title}`, `{year}`).
- `configs/fixture.json`:
  ```json
  {
    "relativeImagePath": "99 - Images & Assets",
    "templatePath": "./smoke/fixture/template",
    "outputPath": "./smoke/out",
    "baseVaultPath": "./smoke/fixture/vault",
    "pdfAppPath": "",
    "wordAppPath": ""
  }
  ```
- `.env` handling: harness sets `BASE_MD_DIR` to the absolute fixture vault path via a `smoke/fixture/.env` loaded with cwd tricks, or sets env vars directly in the child process spawn (`env: { ...process.env, BASE_MD_DIR: <abs>, GCS_BUCKET: 'test-bucket' }`). Prefer explicit env in spawn — do NOT let it read the real `.env`.

### 0.2 GCS dry-run baseline

`publishToGCS.js --dry-run` never writes to GCS or loads the SDK (verified: dry-run path short-circuits `uploadToGCS`, and `getBucket()` is lazy). It DOES write `.publish-state.json` into `BASE_MD_DIR` and rewrites fixture markdown (adds `created`, `guid`). The fixture is disposable so that is acceptable. Capture stdout + the dry-run listing.

Do NOT run without `--dry-run`. Do NOT run `publishToConfluence.js` at all in the harness — it writes to a live Confluence and there is no safe automation for it. Its verification is code review + a stubbed HTTP server (Stage 5).

### 0.3 PDF/HTML baseline

Run `node prettyPdf.js fixture "Base Note" --save-html` with output redirected into `smoke/out/`. Two concerns to neutralize:

- `openPdf()` execs Chrome — with `pdfAppPath: ""` exec fails harmlessly after the PDF is written; that's fine (console.error only).
- Puppeteer runs headless Chromium — this is the real pipeline and must be exercised; PDF bytes differ between puppeteer builds only by metadata, so compare the saved HTML byte-exactly and the PDF page count/text (extract text with `pdftotext` if available, else compare HTML only and note the limitation).
- The `.html` output is the golden file: `smoke/golden/pretty.html`.
- The `.docx` from `node prettyMsWord.js fixture "Base Note"`: `.docx` is a zip; `html-to-docx` embeds a timestamp. Golden-compare the unzipped `word/document.xml` only. Capture as `smoke/golden/word/document.xml`.

### 0.4 Harness scripts

`smoke/baseline.mjs`: spawns each command with the right env/args, copies outputs into `smoke/golden/`. `smoke/verify.mjs`: re-runs the same commands into `smoke/out/` (cleaned first), then diffs:

- `pretty.html` — byte-exact diff required.
- `word/document.xml` — byte-exact diff required.
- GCS dry-run stdout — normalize the volatile lines (mtime-based skips, state file) before diff; the upload plan lines (key, size, content-type) must match exactly.

If puppeteer can't launch Chromium in this environment, fall back to comparing only the HTML golden and record that PDF rendering is unverifiable here — do not fake a pass.

### 0.5 Baseline commit

`git add -A && git commit -m "smoke: golden baseline harness (pre-refactor)"` — includes fixture, golden outputs, harness scripts, and a `.gitignore` entry for `smoke/out/` (golden IS committed).

Gate 0: `npm run verify` passes against the untouched code. This proves the harness itself works.

---

## Stage 1 — Node pinning

- `package.json`: add `"engines": { "node": ">=24.22.1" }`.
- Create `.nvmrc` containing: `24.22.1`.
- No code changes.

Gate 1: `npm run verify` still passes.

Commit: `chore: pin node >=24.22.1 (brotli CVE-2026-111497 floor)`.

---

## Stage 2 — Dead dependency removal

1. Delete from `package.json` and run `npm install` to regenerate lockfile: `obsidian`, `html-docx-js`, `confluence.js` (all verified never imported anywhere).
2. `moment` → replace single use in `publishToGCS.js:210`:
   ```js
   // before
   const createdDate = moment(fs.statSync(file).birthtime).format('MMM D, YYYY h:mm A');
   // after — produces the same "Oct 26, 2026 3:05 PM" shape
   const createdDate = fs.statSync(file).birthtime.toLocaleString('en-US', {
     year: 'numeric', month: 'short', day: 'numeric',
     hour: 'numeric', minute: '2-digit', hour12: true
   }).replace(',', '');
   ```
   (moment's `MMM D, YYYY h:mm A` renders as `Oct 26, 2026 3:05 PM`; toLocaleString gives `Oct 26, 2026, 3:05 PM` — hence the `.replace(',', '')`. Verify by running both formatters side by side on one date BEFORE swapping; keep whichever matches exactly, adjusting the replace to compensate.)
3. `fs-extra` → `fs/promises` in `markdownToHTML.js`, `prettyPdf.js`, `prettyMsWord.js`. Mapping: `fs.readFile` → `(await import('fs/promises')).readFile` (all call sites already `await`), `fs.writeFile` → same, `fs.readdir(directory, { withFileTypes: true })` → identical in core fs. Keep `fs` (non-extra) uses in publishToGCS.js untouched.
4. `axios` → native `fetch` in `publishToConfluence.js` (3 call sites, ~80 lines):
   ```js
   // GET
   const res = await fetch(url, { headers });
   if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { response: await res.text() });
   const data = await res.json();
   // POST / PUT — same shape with method, body: JSON.stringify(data), 'Content-Type': 'application/json'
   ```
   Preserve the existing error logging branches (`error.response` → print body + status; else `error.message`) by re-throwing with `.status`/`.body` attached.
5. `short-uuid` → core crypto in `publishToGCS.js:219`:
   ```js
   // before: m.matter.data = extend(m.matter.data, { guid: short().new().substring(0, 8) });
   m.matter.data.guid = crypto.randomUUID().replaceAll('-', '').substring(0, 8);
   ```
   Add `const crypto = require('node:crypto')` at top. (Keep the same 8-char length: object keys in `.publish-state.json` and GCS note names depend on it.)
6. While in `publishToGCS.js`: replace `let extend = require('util')._extend` and its two uses with object spread:
   ```js
   m.matter.data = { ...m.matter.data, guid: /* see above */ };
   // and
   m.matter.data = { ...m.matter.data, gitURL: gitSettings.gitFileURL };
   ```
   Remove the `extend` import.

Gate 2: `npm run verify` passes (GCS dry-run stdout must be identical apart from a new guid value if the fixture regenerated one — set the fixture note to already carry a fixed `guid` so output is stable). `npm ls` shows none of the six removed packages.

Commit: `refactor: drop dead deps (obsidian, html-docx-js, confluence.js, moment, fs-extra, axios, short-uuid)`.

---

## Stage 3 — ESM conversion

1. `package.json`: add `"type": "module"`.
2. Convert every `.js` file to `.mjs`-style ESM in place (keep `.js` names — `type: module` covers them):
   - `const x = require('y')` → `import x from 'y'`; named requires → named imports.
   - `module.exports = {...}` → `export {...}`.
   - `__dirname` → `import.meta.dirname` (Node ≥20.11; repo has no other `__dirname` uses — verify with a grep before assuming).
   - Config path literals like `` `./configs/${configName}.json` `` resolve from cwd, NOT module dir; entry scripts are already run with cwd = repo root (README documents that requirement), so leave relative-to-cwd behavior unchanged.
3. Files that must convert: `markdownToHTML.js`, `cssMappings.js`, `prettyPdf.js`, `prettyMsWord.js`, `publishToConfluence.js`, `publishToGCS.js`.
4. Watch: `dotenv` → `import dotenv from 'dotenv'`; `glob` → `import { glob } from 'glob'`; `gray-matter` default import; `sass` named import `compileAsync` or default; `html-to-docx` default export; `@google-cloud/storage` named `{ Storage }`; `commonmark` named `{ Parser }`.

Reason ESM is required: marked 18 is ESM-first (`main: './lib/marked.esm.js'`, no require condition). Depending on `require(esm)` is a shim; going all-ESM makes every remaining dual-package dep uniform.

Gate 3: `npm run verify` passes. Also manually run `node publishToGCS.js --dry-run` once against the fixture and eyeball the summary line.

Commit: `refactor: convert to ESM (type: module)`.

---

## Stage 4 — Major-version migrations

### 4.1 marked 11 → 18 (breaking: renderer token API)

In `markdownToHTML.js` the current code (line ~14-18, ~44-45):

```js
// OLD (v11): heading(text, level) string signature
const renderers = {
    heading(text, level) {
        return `<h${level} id="${toAnchorId(text)}">${text}</h${level}>`;
    }
};
marked.use({ gfm: true, renderer: renderers });   // re-registered on EVERY call — global mutation bug
let html = marked(markdown);
```

Rewrite as module-scope, registered ONCE (fixes the per-call global mutation bug):

```js
const { Marked } = await import('marked');  // or: import { Marked } from 'marked'
const md = new Marked();
md.use({
  gfm: true,
  renderer: {
    // v13+ token-object signature
    heading(token) {
      const inner = this.parser.parseInline(token.tokens);
      return `<h${token.depth} id="${toAnchorId(inner)}">${inner}</h${token.depth}>\n`;
    }
  }
});
// call site:
let html = md.parse(markdown);
```

CRITICAL parity checks:
- The OLD `text` argument in v11 was already-rendered inline HTML; `this.parser.parseInline(token.tokens)` is the v13+ equivalent. Do NOT pass raw text.
- `toAnchorId()` currently receives rendered text; keep the same input semantics or anchor ids change and the TOC links break. `buildTOC` builds links with `toAnchorId(t.title)` where `t.title` is raw commonmark heading text — after migration, confirm heading `id` and TOC link target still match for a heading containing an em/code span (add such a heading to the fixture if not present; if ids diverge, post-process: generate the id from `token.text` (raw) instead of rendered inner, matching what commonmark TOC walker sees).
- Old marked appended `\n` after block elements; v18 renderer may differ — the golden HTML diff is the arbiter. If the ONLY diffs are trailing `\n` inside/after headings, adjust the heading renderer return to include/exclude `\n` to match golden, do not accept whitespace drift silently.

### 4.2 jimp 0.22 → 1.6 (breaking: full rewrite)

In `markdownToHTML.js` (~lines 2, 97-129):

```js
// OLD
const Jimp = require('jimp');
const image = await Jimp.read(filePath);
image.resize(maxWidth, Jimp.AUTO);
const buffer = await image.quality(70).getBufferAsync(Jimp.MIME_JPEG);
```

```js
// NEW (jimp 1.x)
import { Jimp } from 'jimp';
const image = await Jimp.read(filePath);
if (image.width > maxWidth) {
  image.resize({ w: maxWidth });          // height auto-scales; Jimp.AUTO constant is gone
}
const mime = ['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg' : 'image/png';
if (mime === 'image/jpeg') image.quality(70);   // set BEFORE getBuffer; v1 quality takes 0-100
const buffer = await image.getBuffer(mime);     // v1: promise-based getBuffer(mime)
return buffer.toString('base64');
```

KNOWN UNAVOIDABLE DRIFT: jimp 1.x's JPEG/PNG encoders are not byte-identical to 0.22, so the base64 payloads inside `pretty.html` WILL differ. Verification protocol for this stage:
1. Run verify; expect diff confined to `src="data:image/...` attributes.
2. Confirm no OTHER structural diffs (headings, TOC, css block, hashtag spans) — these must be byte-exact.
3. Decode both old and new data URIs, load each with jimp 1.x, and assert `image.bitmap.data` equality only if dimensions match; if encoder quality differences alter bytes but not pixels-dimensions, accept and UPDATE the golden baseline (explicitly, in the same commit, with a note).
4. The 2000px resize behavior must be preserved: assert `image.width === 2000` on the decoded output for the >2000px fixtures.

### 4.3 puppeteer (already 25.16.0 — config fix only)

`prettyPdf.js:48`: `headless: "new"` → `headless: true` (`"new"` is a legacy value from the old headless split; `true` is the modern headless).

### 4.4 compatible bumps

`npm install @google-cloud/storage@^8.4.0 commonmark@^0.31.2 dotenv@^18.0.9 glob@^13.0.6 gray-matter@^4.0.3 html-to-docx@^1.8.0 jimp@^1.6.1 marked@^18.1.1 puppeteer@^25.16.0 sass@^1.106.1` (with package.json cleaned to exactly the target dependency set from the top of this plan).

`glob@13`: `glob.sync` still exists; verify the three call sites in `publishToGCS.js` still resolve. If `glob.sync` was removed in v13 (check the changelog before assuming), replace with `{ globSync } from 'glob'` keeping identical patterns.

`commonmark@0.31`: walker API unchanged; verify `buildTOC` output via golden HTML (TOC links are inside it).

Gate 4: `npm run verify` passes with only the accepted image-encoder drift (documented above); `npm audit` clean or only dev-irrelevant items.

Commit: `refactor: marked 18 + jimp 1 + puppeteer headless + compatible bumps`.

---

## Stage 5 — Shared module extraction

Create the `lib/` modules, then rewrite the four entry scripts as thin consumers. Move files, don't fork them: `git mv markdownToHTML.js lib/markdownToHTML.js` and `git mv cssMappings.js lib/cssMappings.js`, then update the require/import of `cssMappings` inside it.

### lib/config.js

```js
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

export function parseArgs(argv, { flags = [] } = {}) {
  const flagSet = Object.fromEntries(flags.map((f) => [f, argv.includes(f)]));
  const positional = argv.filter((a) => !a.startsWith('--'));
  return { ...flagSet, positional };
}

export function loadConfig(configName = 'arcMain', fileName) {
  const configText = fs.readFileSync(path.join('configs', `${configName}.json`), 'utf8');
  const config = JSON.parse(configText);
  const baseVaultPath = config.baseVaultPath;
  const paths = {
    baseVaultPath,
    imgDir: path.join(baseVaultPath, config.relativeImagePath),
    cssPath: path.join(config.templatePath, 'style.scss'),
    headerPath: path.join(config.templatePath, 'header.html'),
    footerPath: path.join(config.templatePath, 'footer.html'),
    bodyPath: path.join(config.templatePath, 'body.html'),
    outputPath: config.outputPath,
    pdfAppPath: process.env.PDF_APP_PATH ?? config.pdfAppPath,
    wordAppPath: config.wordAppPath ?? 'C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE',
  };
  return { config, paths, fileName };
}

// Word options are per-template; missing file is a CONFIG ERROR, not a crash.
export function loadWordOptions(templatePath) {
  const p = path.join(templatePath, 'msword.json');
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${p} — template must include msword.json`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
```

Behavior preserved: `pdfAppPath` env→config→(caller default `'C:/Program Files/Google/Chrome/Application/chrome.exe'` — keep the caller-side `??` default in prettyPdf.js exactly as today, including its current `console.log(pdfAppPath)` line — decide: keep the log for parity or drop it; if dropped, note in commit). `loadWordOptions` deliberately changes a crash into a clear error message (pre-approved bug fix).

### lib/vault.js

Single `findFileByName(directory, fileName)` — take the exact implementation from `prettyPdf.js:94-119` (async, Dirent-based, recursive, returns null when absent). Export `walkVault(dir)` moved verbatim from `publishToGCS.js:77-86` (sync, skips dotfiles/node_modules, `.md` files only).

### lib/frontmatter.js

```js
import matter from 'gray-matter';

// matter.stringify(string, ...) re-parses the string, so a body that itself starts with
// a bad '---' block throws. Pass an object to skip the parse.
export function stringifyNote(content, data) {
  return matter.stringify({ content }, data);
}

// True if the leading '---' front matter block contains a top-level publish: key
export function hasPublishKey(text) {
  const block = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  return block !== null && /^publish:/m.test(block[1]);
}
```

(Comment carried over from `publishToGCS.js` — it encodes real gotcha knowledge.)

### lib/open.js

```js
import { spawn } from 'node:child_process';

// Fire-and-forget: spawn detached so the parent CLI can exit while the app stays open.
export function openInApp(filePath, appPath) {
  const child = spawn(appPath, [filePath], { detached: true, stdio: 'ignore' });
  child.unref();
}
```

This intentionally unifies the buggy `exec` PDF path (which waits on Chrome, `prettyPdf.js:84-92`) with the correct spawn path. Console messages like 'PDF opened with Chrome.' move to (or are dropped from) callers — keep one log line per caller so behavior parity is visible.

### lib/markdownToHTML.js

Moved file with the Stage-4 marked/jimp rewrites inside. Exports unchanged: `convertMarkdownToHTML(markdownFilePath, config)` where config = `{ imgDir, cssPath, headerPath, footerPath, bodyPath }`. Internally it now imports `cssMappings` from `./cssMappings.js` and frontmatter helpers from `./frontmatter.js`.

### Entry script rewrites

Each becomes ~40 lines: import from `lib/`, parse args (same defaults: config `arcMain` when absent), find file, convert, write, open. Specific fixes that MUST land here:

- `prettyPdf.js` / `prettyMsWord.js`: `await convertToPDF(filePath)` / `await convertToWord(filePath)` inside the main IIFE (currently missing `await` — process could exit early).
- `prettyMsWord.js`: `loadWordOptions` used instead of raw top-level read (crash → clear message).
- `publishToConfluence.js`: unchanged behavior, just thin; fetch stays.
- `publishToGCS.js`: imports `walkVault`, `stringifyNote`, `hasPublishKey` from lib; everything else (state cache, git sync, dry-run/refresh) stays inline — it has no second consumer and should not be over-abstracted.

### publishToConfluence.js verification (no live writes)

Spin a stub HTTP server in `smoke/verify-confluence.mjs` (node:http): respond to `GET /rest/api/content?...` with `{ results: [] }`, capture `POST /rest/api/content` body, assert it is JSON with the expected `title`, `body.editor.value` containing the golden HTML (image tags have `<br/>` appended and `max-width: 500px` style — preserve those two transforms exactly as `publishToConfluence.js:47`), then respond `{ id: '1' }`. Point `CONFLUENCE_HOST` at `http://127.0.0.1:<port>`. This proves request shape; live Confluence behavior is NOT verifiable here — flag to the user that the first real Confluence publish after the refactor should be watched.

Gate 5: `npm run verify` passes; `smoke/verify-confluence.mjs` passes; each entry script runs with `--help`-less arg errors still degrading the same way (config missing → ENOENT, same as today; do not add new arg-parsing UX beyond parity).

Commit: `refactor: extract lib/ shared modules; thin entry scripts`.

---

## Stage 6 — Docs, audit, cleanup

1. README rewrite:
   - Dependencies section: the 10 remaining packages.
   - Hard requirement: Node ≥ 24.22.1 (call out CVE-2026-111497 and the 2026-10-21 security releases).
   - `lib/` architecture paragraph + smoke harness usage (`npm run baseline` / `npm run verify`).
   - Delete the stale `node-sass` mention (README line ~121 — it's `sass` now).
   - Keep all user-facing how-to content (Obsidian Shell Commands, config keys, frontmatter css keys) — it's still accurate.
   - Add `publishToConfluence` section if content for it is missing; otherwise leave user docs untouched.
2. `npm audit` — expect clean; report anything remaining.
3. Cleanup: remove any scratch files; keep `smoke/` (golden + fixture + harness are now permanent regression tests; `.gitignore` covers `smoke/out/`).
4. Final commit: `docs: post-refactor README; final audit`.

## Final acceptance checklist

- [ ] `npm run verify` green: pretty.html byte-exact (or documented image-encoder drift only), word/document.xml byte-exact, GCS dry-run listing identical.
- [ ] `smoke/verify-confluence.mjs` green.
- [ ] `npm ls` — exactly the 10 target deps; no `obsidian`, `html-docx-js`, `confluence.js`, `moment`, `fs-extra`, `axios`, `short-uuid`.
- [ ] `.nvmrc` = 24.22.1; engines floor set.
- [ ] `grep -r "util._extend\|Jimp.AUTO\|headless: .new.\|short().new\|require("` across repo root and `lib/` returns nothing (ESM + migration complete).
- [ ] Each of the 4 entry scripts runs end-to-end against the fixture.
- [ ] 7 commits, one per stage, all gates passed in order.

## Risk register (for the executing agent)

| Risk | Detection | Response |
|---|---|---|
| marked 18 heading output differs (whitespace, anchor id) | golden HTML diff | Adjust renderer return string (trailing `\n`) / generate id from `token.text` to restore TOC↔anchor parity; never accept silent drift |
| jimp 1 encoder byte drift | golden HTML diff shows only data-URI changes | Verify pixel dimensions match, then update golden in-commit with note |
| glob v13 sync API change | `npm ls glob` + run GCS dry-run | Switch to `globSync` import |
| ESM breaks cwd-relative config paths | entry scripts fail with ENOENT on configs/ | Scripts were always cwd-dependent; run from repo root (documented). Do not silently switch to import.meta paths without checking README expectations |
| DOCX diff noisy beyond document.xml | unzip diff | Restrict comparison to `word/document.xml`; note anything else |
| Puppeteer cannot launch in sandbox | harness failure | Compare HTML goldens only; report PDF rendering as unverifiable — do not fake a pass |
| Confluence regression invisible to harness | n/a (no live writes) | Stop at code review + stub-server proof; tell user to watch first real publish |

## Out of scope (do NOT do)

- No new CLI features, no new flags, no arg-parsing UX changes.
- No changes to `configs/*.json`, `templates/**` user files (fixture templates are new files under `smoke/`).
- No touching `.env` or `.env.example` beyond nothing — GCS env names stay identical.
- No test framework (jest/vitest/etc.) — the smoke harness IS the verification.
- No refactoring inside `publishToGCS.js`'s sync/state logic beyond the extraction listed; its caching and git-sync semantics are load-bearing.
