let extend = require('util')._extend;
let fs = require('fs');
let path = require('path');
const { glob } = require("glob");
const dotenv = require('dotenv');
let matter = require('gray-matter');
let short = require('short-uuid');
const { Storage } = require('@google-cloud/storage');
const moment = require('moment');

// Get env variables
dotenv.config();
const baseDir = process.env.BASE_MD_DIR;
const gcsBucketName = process.env.GCS_BUCKET || 'nstepro-sites';
const subDirForGit = process.env.GIT_PUBLISH_SUBDIR;
const gitPath = process.env.GIT_REPO_ABSDIR;
const gitURL = process.env.GIT_REPO_URL;
// Auth: Application Default Credentials (ADC) by default; a service-account key
// file is picked up automatically via GOOGLE_APPLICATION_CREDENTIALS if set.
const storage = new Storage();
const bucket = storage.bucket(gcsBucketName);

// Optional dry-run flag: print planned uploads without writing anything
const dryRun = process.argv.includes('--dry-run');

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

async function listExistingObjects() {
    const [files] = await bucket.getFiles({ prefix: 'grimace/' });
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
    return bucket.file(`grimace/${key}`).save(fileContent, {
        contentType,
        resumable: false,
        metadata: { cacheControl: path.extname(key) === '.md' ? undefined : 'public, max-age=3600' }
    }).then(() => ({ ok: true })).catch((err) => ({ ok: false, key, err }));
}

async function main() {
    const objectMap = await listExistingObjects();
    await mainFileLoop(objectMap);
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

async function mainFileLoop(objectMap) {
    const results = { uploaded: 0, skipped: 0, failed: 0, invalid: 0 };
    const failures = [];
    // Loop through files
    const files = await glob(baseDir + '/**/*.md');
    for (const file of files) {

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
            const createdDate = moment(fs.statSync(file).birthtime).format('MMM D, YYYY h:mm A');
            if (m.matter.data.created === undefined || m.matter.data.created === null) {
                m.matter.data.created = createdDate;
                fs.writeFileSync(file, stringifyNote(m.matter.content, m.matter.data));
            }

            // If GUID doesn't already exist
            if (m.matter.data.guid === undefined) {
                // Add new GUID tag
                m.matter.data = extend(m.matter.data, { guid: short().new().substring(0, 8) });
                gitSettings.updateFile = true;
            }

            // Only proceed if updated since last GCS file (or GCS file doesn't exist)
            if (fs.statSync(file).mtime > objectMap[m.matter.data.guid] || objectMap[m.matter.data.guid] == undefined) {
                console.log(`Processing modified file: ${path.parse(file).name}`);

                // If GitURL doesn't exist (or is misaligned) - add it
                if (gitSettings.gitPublish && gitSettings.gitFileURL !== m.matter.data.gitURL) {
                    m.matter.data = extend(m.matter.data, { gitURL: gitSettings.gitFileURL });
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
                } else {
                    results.failed++;
                    failures.push(res);
                }
            } else {
                results.skipped++;
            }
        }
    }

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
