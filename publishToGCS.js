import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { glob } from "glob";
import dotenv from 'dotenv';
import matter from 'gray-matter';
import { Storage } from '@google-cloud/storage';

// Get env variables
dotenv.config();
const baseDir = process.env.BASE_MD_DIR;
const gcsBucketName = process.env.GCS_BUCKET || 'nstepro-sites';
const subDirForGit = process.env.GIT_PUBLISH_SUBDIR;
const gitPath = process.env.GIT_REPO_ABSDIR;
const gitURL = process.env.GIT_REPO_URL;
// Auth: Application Default Credentials (ADC) by default; a service-account key
// file is picked up automatically via GOOGLE_APPLICATION_CREDENTIALS if set.
// Lazy: runs with nothing to upload never load the SDK or touch the network.
let bucket_;
function getBucket() {
    if (!bucket_) {
        bucket_ = new Storage().bucket(gcsBucketName);
    }
    return bucket_;
}

// Optional dry-run flag: print planned uploads without writing anything
const dryRun = process.argv.includes('--dry-run');
// --refresh: ignore/rebuild the local cache by re-listing GCS once
const refresh = process.argv.includes('--refresh');

const STATE_FILE = '.publish-state.json';
// Map abs file path -> { mtimeMs, guid }; written after every successful upload
let publishState = {};

const CONTENT_TYPES = {
    '.md': 'text/markdown; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
};

function contentTypeFor(name) {
    return CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

// Note keys are site-prefixed; the projects grid lives at the site root, all
// other notes under note/. Images live under images/.
function gcsKeyForNote(guid) {
    return guid === 'grimace-project-list' ? 'grimace-project-list.md' : `note/${guid}.md`;
}

function statePath() {
    return path.join(baseDir, STATE_FILE);
}

function loadPublishState() {
    if (refresh) return {};
    try {
        publishState = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    } catch {
        publishState = {}; // first run or unreadable cache
    }
    return publishState;
}

function savePublishState() {
    fs.writeFileSync(statePath(), JSON.stringify(publishState, null, 2));
}

// Recursively list .md files without reading them; skips vault-internal dirs
function walkVault(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walkVault(p));
        else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
    }
    return out;
}

async function listExistingObjects() {
    const [files] = await getBucket().getFiles({ prefix: 'grimace/' });
    const objectMap = {};
    files.forEach((f) => {
        if (/^grimace\/note\/.+\.md$/.test(f.name)) {
            const guid = path.basename(f.name, '.md');
            objectMap[guid] = new Date(f.metadata.updated);
        } else if (f.name === 'grimace/grimace-project-list.md') {
            objectMap['grimace-project-list'] = new Date(f.metadata.updated);
        }
    });
    return objectMap;
}

function uploadToGCS(key, fileContent) {
    const contentType = contentTypeFor(key);
    if (dryRun) {
        console.log(`[dry-run] upload gs://${gcsBucketName}/grimace/${key} (${fileContent.length} bytes, ${contentType})`);
        return Promise.resolve({ ok: true });
    }
    return getBucket().file(`grimace/${key}`).save(fileContent, {
        contentType,
        resumable: false,
        metadata: { cacheControl: path.extname(key) === '.md' ? undefined : 'public, max-age=3600' }
    }).then(() => ({ ok: true })).catch((err) => ({ ok: false, key, err }));
}

async function main() {
    const cached = loadPublishState();
    const files = walkVault(baseDir);

    // Cheap prefilter: only read + parse notes missing from the cache or
    // modified since their last publish. Unchanged notes are never opened.
    const candidates = [];
    for (const file of files) {
        let mtimeMs;
        try {
            mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
            continue; // deleted between walk and stat
        }
        const entry = cached[file];
        if (!entry || entry.mtimeMs !== mtimeMs) candidates.push(file);
    }

    if (candidates.length === 0 && !refresh) {
        console.log('No changes since last publish.');
        return;
    }

    // Last-published mtimes: cache if complete, else reseed from GCS once
    let objectMap = null;
    if (refresh || candidates.some((f) => !cached[f])) {
        objectMap = await listExistingObjects();
        // Seed cache from GCS listing so unchanged published notes are never re-uploaded
        for (const file of candidates) {
            if (cached[file]) continue;
            // Read just enough to learn the guid; only for files the cache lacks
            const text = fs.readFileSync(file, 'utf8');
            if (!hasPublishKey(text)) continue;
            const guidMatch = text.match(/^guid:\s*(\S+)/m);
            if (guidMatch && objectMap[guidMatch[1]] !== undefined) {
                publishState[file] = { mtimeMs: fs.statSync(file).mtimeMs, guid: guidMatch[1] };
            }
        }
        fs.writeFileSync(statePath(), JSON.stringify(publishState, null, 2));
    }

    await mainFileLoop(objectMap, candidates, cached);
}

let uploadFailures = [];

// matter.stringify(string, ...) re-parses the string, so a body that itself starts with
// a bad '---' block throws. Pass an object to skip the parse.
function stringifyNote(content, data) {
    return matter.stringify({ content }, data);
}

// True if the leading '---' front matter block contains a top-level publish: key
function hasPublishKey(text) {
    const block = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
    return block !== null && /^publish:/m.test(block[1]);
}

async function mainFileLoop(objectMap, candidates, cached) {
    const results = { uploaded: 0, skipped: 0, failed: 0, invalid: 0 };
    const failures = [];
    // Loop through files
    for (const file of candidates) {

        // Read front matter
        let m = {};
        m.file = fs.readFileSync(file);

        // Cheap prefilter: skip notes with no publish key before any YAML parse
        if (!hasPublishKey(m.file.toString('utf8'))) {
            continue;
        }

        try {
            m.matter = matter(m.file);
        } catch (err) {
            // Malformed front matter: warn and skip rather than fail the run
            console.warn(`WARNING: skipping ${path.parse(file).name}, bad frontmatter: ${err.reason || err.message}`);
            results.invalid++;
            continue;
        }

        // Git settings
        var gitSettings = {}
        gitSettings.gitPublish = (!(subDirForGit == null || gitPath == null) && file.indexOf(subDirForGit) >= 0 && m.matter.data.gitURL !== undefined);
        gitSettings.curAbsDir = path.parse(file).dir;
        gitSettings.relDir = gitSettings.gitPublish ? gitSettings.curAbsDir.substring(gitSettings.curAbsDir.indexOf(subDirForGit) + subDirForGit.length) : '';
        gitSettings.gitAbsDir = gitPath + '/' + gitSettings.relDir;
        gitSettings.gitFileURL = gitURL + '/' + encodeURIComponent(gitSettings.relDir) + '/' + encodeURIComponent(path.parse(file).base);
        gitSettings.updateFile = false;

        // If publish tag is added
        if (m.matter.data.publish) {

            // Get create/modify dates (published notes only)
            const createdDate = fs.statSync(file).birthtime.toLocaleString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit', hour12: true
            }).replace(/(\d{4}),/, '$1');
            if (m.matter.data.created === undefined || m.matter.data.created === null) {
                m.matter.data.created = createdDate;
                fs.writeFileSync(file, stringifyNote(m.matter.content, m.matter.data));
            }

            // If GUID doesn't already exist
            if (m.matter.data.guid === undefined) {
                // Add new GUID tag (8 chars, same shape short-uuid produced)
                m.matter.data = { ...m.matter.data, guid: crypto.randomUUID().replaceAll('-', '').substring(0, 8) };
                gitSettings.updateFile = true;
            }

            // Only proceed if updated since last publish (cache first, GCS fallback)
            const lastPublished = cached[file]?.mtimeMs ?? objectMap?.[m.matter.data.guid];
            if (lastPublished === undefined || fs.statSync(file).mtimeMs > lastPublished) {
                console.log(`Processing modified file: ${path.parse(file).name}`);

                // If GitURL doesn't exist (or is misaligned) - add it
                if (gitSettings.gitPublish && gitSettings.gitFileURL !== m.matter.data.gitURL) {
                    m.matter.data = { ...m.matter.data, gitURL: gitSettings.gitFileURL };
                    gitSettings.updateFile = true;
                }

                // Update file in-place
                if (gitSettings.updateFile) {
                    fs.writeFileSync(file, stringifyNote(m.matter.content, m.matter.data));
                }

                // CONTENT MODIFICATIONS
                // Handle embedded images and markdown
                m.matter.content = await processEmbeds(m.matter.content, m.matter.data);

                // Handle remaining links
                m.matter.content = processRelativePathLinks(m.matter.content, file);

                // GCS/GIT SYNC
                // Git Sync
                if (gitSettings.gitPublish) {
                    var gitContent = m.matter.content;
                    gitContent = processGitImages(gitContent, gitSettings, file);

                    // Create path if not exists
                    if (!fs.existsSync(gitSettings.gitAbsDir)) {
                        fs.mkdirSync(gitSettings.gitAbsDir, { recursive: true });
                    }

                    // Copy file
                    fs.writeFileSync(gitSettings.gitAbsDir + '/' + path.parse(file).base, stringifyNote(gitContent, {}));
                }

                // Log for reporting
                // Add title
                m.matter.content = `# ${path.parse(file).name} \n --- \n` + m.matter.content;

                // Upload note to GCS (overwrite if exists)
                const res = await uploadToGCS(gcsKeyForNote(m.matter.data.guid), stringifyNote(m.matter.content, m.matter.data));
                if (res.ok) {
                    results.uploaded++;
                    if (!dryRun) {
                        publishState[file] = { mtimeMs: fs.statSync(file).mtimeMs, guid: m.matter.data.guid };
                    }
                } else {
                    results.failed++;
                    failures.push(res);
                }
            } else {
                results.skipped++;
            }
        }
    }

    // Drop cache entries for files no longer in the vault
    const livePaths = new Set(candidates);
    for (const file of Object.keys(publishState)) {
        if (!livePaths.has(file)) delete publishState[file];
    }
    fs.writeFileSync(statePath(), JSON.stringify(publishState, null, 2));

    const allFailures = failures.concat(uploadFailures);
    console.log(`\nPublish summary: ${results.uploaded} uploaded, ${results.skipped} skipped, ${results.invalid} skipped for bad frontmatter, ${allFailures.length} failed${dryRun ? ' (dry-run, nothing written)' : ''}`);
    allFailures.forEach((f) => console.error(`FAILED: ${f.key}: ${f.err.message}`));
    if (allFailures.length > 0) {
        process.exitCode = 1;
    }
}

async function processEmbeds(content, data) {
    var images = [];
    var uploadResults = [];
    content.split('![[').forEach((str, i) => {
        if (i > 0) {
            images.push(str.split(']]')[0]);
        }
    });
    if (data.links != undefined) {
        data.links.forEach((link) => {
            images.push(link.img);
        });
    }

    for (const imgName of images) {
        // If not an image, treat as markdown embed and replace contents inline
        if (!imgName.match(/\.(jpe?g|png|gif|svg|webp)$/i)) {
            glob.sync(baseDir + `/**/${imgName}.md`).forEach(file => {
                var docData = fs.readFileSync(file);
                var docContent;
                try {
                    docContent = matter(docData);
                } catch (err) {
                    // Leave the embed as-is rather than abort the note
                    console.warn(`WARNING: embed ${imgName} has bad frontmatter, not inlined: ${err.reason || err.message}`);
                    return;
                }
                content =content.replace(new RegExp(`!\\[\\[${imgName}]]`, 'g'), docContent.content);
            });
        }
        // Else upload the image
        else {
            const imgFiles = glob.sync(baseDir + `/**/${imgName}`);
            if (imgFiles.length === 0) {
                console.warn(`WARNING: embed not found in vault: ${imgName}`);
            }
            for (const file of imgFiles) {
                var imgData = fs.readFileSync(file);
                uploadResults.push(await uploadToGCS(`images/${imgName}`, imgData));
            }
        }
    }
    if (uploadResults.some((r) => !r.ok)) {
        uploadFailures.push(...uploadResults.filter((r) => !r.ok));
    }
    return content;
}

function processGitImages(content, gitSettings, file) {
    content.split('![[').forEach((str, i) => {
        if (i > 0) {
            var imgName = str.split(']]')[0];

            if (imgName.match(/\.(jpe?g|png|gif|svg|webp)$/i)) {
                glob.sync(baseDir + `/**/${imgName}`).forEach(imgFile => {

                    // Make images directory if not exists
                    var tgtFileDir = gitPath + '/images';
                    var tgtFileAbsPath = tgtFileDir + '/' + imgName;
                    var tgtFileRelPath = path.relative(gitSettings.relDir, 'images/' + imgName).replace(/\\/g, "/");

                    if (!fs.existsSync(tgtFileDir)) {
                        fs.mkdirSync(tgtFileDir);
                    }
                    fs.copyFileSync(imgFile, tgtFileAbsPath);
                    content = content.replace(new RegExp(`!\\[\\[${imgName}]]`, 'g'), `![${imgName}](${encodeURI(tgtFileRelPath)})`);
                });
            }
        }
    });
    return content;
}

function processRelativePathLinks(content, file) {
    content.split('[[').forEach((str, i) => {
        if (i > 0) {
            var linkName = str.split(']]')[0];
            if (!linkName.toLowerCase().startsWith("http")) {
                glob.sync(baseDir + `/**/${linkName}.md`).forEach(linkedFile => {
                    var relPath = path.relative(path.dirname(file), linkedFile).replace(/\\/g, "/");
                    content = content.replace(new RegExp(`\\[\\[${linkName}]]`, 'g'), `[${linkName}](${encodeURI(relPath)})`);
                });
            }
        }
    });
    return content;
}

main().catch((err) => {
    console.error('Publish failed:', err.stack || err.message);
    process.exitCode = 1;
});
