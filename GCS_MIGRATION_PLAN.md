# Obsidian Utilities → GCS Migration Plan

Status: **proposed — awaiting review before refactor.**
Scope: `publishToS3.js` (the publish flow) only. `prettyPdf.js`, `prettyMsWord.js`, `publishToConfluence.js`, `markdownToHTML.js`, `cssMappings.js`, templates, and configs are AWS-free and untouched.

## 1. Ground truth (verified 2026-10-25)

- New site: `nstepro-sites` monorepo; grimace SPA at `/grimace/`, Cloud Run service `nstepro-sites` (us-central1), deployed and serving.
- Content store: **`gs://nstepro-sites`** (US-CENTRAL1, public-read objects), keys site-prefixed:
  - `grimace/grimace-project-list.md` (projects grid)
  - `grimace/note/{guid}.md` — 15 notes migrated
  - `grimace/images/{name}` — 78 images migrated
- Reader contract (new `Notes.jsx` + `routes/content.js`):
  - `GET /grimace/api/content/grimace/note/{guid}.md` → `{frontmatter, body}` (server strips frontmatter).
  - `![[img]]` wiki-embeds resolved client-side via `GET /grimace/api/content/grimace/images/{img}?format=signed-url` → public `https://storage.googleapis.com/nstepro-sites/grimace/images/{img}`.
  - `frontmatter.links[].img` cards use the same `images/` prefix.
- Old publisher's object format: frontmatter, then body **prepended with `# {vault filename}\n---\n`**. `Notes.jsx` uses that first heading as the page title/TOC root and slices it out of the body.

### ⚠️ Defect found in migrated data

The 15 bucket notes were staged from vault files and are **missing the `# Title\n---` line** (verified: `grimace/note/90s-movies.md` body starts `![[90s-movies.png]]`, `coffee-shop.md` starts `### What Our Coffee Orders Say`). Consequences on the live new site:
- `Notes.jsx` `slice(indexOf("\n"))` **deletes the first body line** (e.g. the hero image embed of 90s-movies).
- `buildTOC` promotes the first `###` to the page title → wrong titles.

Fix is in §5. The refactored publisher must keep prepending the H1 (existing behavior — just don't lose it).

## 2. Key mapping (S3 flat → GCS prefixed)

| Old S3 key | New GCS key | Notes |
|---|---|---|
| `{guid}.md` | `grimace/note/{guid}.md` | All published notes |
| `grimace-project-list.md` (guid `grimace-project-list`) | `grimace/grimace-project-list.md` | **Special case: prefix root, not `note/`** (matches stage-grimace.mjs + server expectations) |
| `{image filename}` | `grimace/images/{image filename}` | Wiki-embeds + `links[].img` |

Uniqueness scope changes from whole-bucket-flat to `note/` — same practical constraint, no action needed.

## 3. `publishToS3.js` → `publishToGCS.js` changes

Rename the file; keep the overall flow (scan → gate on mtime → mutate frontmatter in-place → transform content → upload → optional git sync). Changes:

1. **Client**: `aws-sdk` → `@google-cloud/storage` (v7). Single `Storage` instance; auth per §4.
2. **Keying** (`uploadToS3` → `uploadToGCS(key, content, opts)`):
   - Note: `note/${guid}.md` unless `guid === 'grimace-project-list'` → `grimace-project-list.md`.
   - Image: `images/${imgName}`.
3. **Content-Type is now mandatory.** The bucket serves images publicly; `file.save()` without `contentType` stores `application/octet-stream` and browsers download instead of render. Map by extension (`image/png|jpeg|gif|svg|webp`); notes as `text/markdown; charset=utf-8`. Match migrated objects' `Cache-Control: public, max-age=3600` on images.
4. **Modified-check**: replace `s3.listObjectsV2` with `bucket.getFiles({ prefix: 'grimace/' })`, map `note/{guid}.md` → `metadata.updated` (Date), compare against local `mtime`. Same semantics as today.
5. **H1 prepend: keep exactly as-is** (`# ${vault filename}\n---\n` before body, after content transforms). Required by `Notes.jsx` title/TOC/slice logic (§1).
6. **Widen image regex** `/\.(jpg|jpeg|png|gif)$/i` → `/\.(jpe?g|png|gif|svg|webp)$/i` in `processEmbeds` and `processGitImages` (the site's matcher already includes svg/webp; existing bucket has `.jpeg`).
7. **Set `resumable: false`** on saves (small files; avoids temp-file churn on Windows).
8. Unchanged behaviors to preserve verbatim: GUID minting (`short-uuid`), `created` backfill via `fs.birthtime`, `gitURL` frontmatter sync + git mirror (`processGitImages`, rel-path linking, `processRelativePathLinks`), non-image `![[note]]` embeds inlined from vault, `matter.stringify` round-trips.
9. **`package.json`**: remove `aws-sdk`, add `@google-cloud/storage`. Regen lockfile.
10. **Failure handling upgrade (small)**: current S3 callbacks `console.log` errors and the process exits 0 — publishes fail *silently* (CONSOLIDATION_PLAN §6 calls this out). Collect upload results, print a summary (uploaded/skipped/failed), `process.exitCode = 1` on any failure.

## 4. Auth to GCP (recommendation)

**Recommended: ADC — `gcloud auth application-default login`.**
- Zero key material on disk, nothing in `.env`, matches the pattern `nstepro-sites` already uses locally (CUTOVER_RUNBOOK §1) and on Cloud Run (runtime SA). Your gcloud CLI is already authed; ADC is one command and the Node library picks it up automatically (`new Storage()` with no args).
- Publisher is a manually-invoked personal CLI on your own machine — user-account ADC is the right fit; no expiry to manage beyond occasional `gcloud auth application-default login` re-run (refresh token revoked ~6 months if unused, trivial to redo).

**Alternative (least privilege): dedicated service account + key file.**
- `obsidian-publisher@nstepro-sites.iam.gserviceaccount.com` with `roles/storage.objectUser` granted **on the bucket only** (`gs://nstepro-sites`), not the project. Key file path in `GOOGLE_APPLICATION_CREDENTIALS`, picked up by the library automatically.
- Tradeoff: caps blast radius to one bucket and separates publishing creds from your owner account — but adds a long-lived key file to manage/rotate on the same disk that already holds your gcloud owner creds, so it's ceremony without real gain here. Choose it only if you ever run publishing from a machine you don't fully control.

Do **not** reuse the Cloud Run runtime SA (`nstepro-sites-runtime@…` — project-level `storage.objectAdmin`) for the publisher; that's the server's identity.

### Env vars

```dotenv
# Unchanged
BASE_MD_DIR=C:/path/to/vault
GIT_PUBLISH_SUBDIR=/ProductDocs/        # optional, unchanged
GIT_REPO_ABSDIR=C:/git/my-git-repo      # optional, unchanged
GIT_REPO_URL=https://github.com/...     # optional, unchanged

# New (replaces all AWS_*)
GCS_BUCKET=nstepro-sites                # default; can be omitted
# Auth: ADC by default. Optional override:
# GOOGLE_APPLICATION_CREDENTIALS=C:/keys/obsidian-publisher.json
```

Add a committed `.env.example` (none exists today; `.env` is already gitignored). Delete `AWS_*` from the README's S3 Publish section and rewrite it as "GCS Publish".

## 5. One-time data remediation (before/with the refactor)

Restore the `# {Title}\n---\n` line to the 15 migrated `grimace/note/*.md` objects (§1 defect). Titles are the vault filenames — source of truth: `C:/Users/NICHO/git/_migration/grimace/*.md` (same bytes as bucket; verified for 90s-movies). Throwaway script: for each `note/{guid}.md`, find matching vault file by `guid` frontmatter, `matter.stringify(\`# ${vaultName}\n---\n${body}\`, frontmatter)`, re-save with `text/markdown` + same `Cache-Control`. Then verify each note's first body line is its `# Title` and hero embeds render on the `*.run.app` URL.

Optional follow-up flag (new-site bug, not this repo): `Notes.jsx:35` interpolates image URLs unencoded — `images/Pasted image 20230521083730.png` contains spaces and CommonMark will not parse an unencoded space in an image destination. Project components use `encodeURI(...)`; Notes.jsx should too. 40+ of the 78 migrated images have spaces in names. Recommend fixing in `nstepro-sites` (one-line change) rather than renaming vault images.

## 6. Verification plan

1. **Dry-run mode**: `node publishToGCS.js --dry-run` prints planned uploads (key, size, content-type) without writing. (New flag; the old script had zero visibility.)
2. **Smoke publish**: tag a scratch note `publish: true`, run the publisher, then:
   - `curl https://…a.run.app/grimace/api/content/grimace/note/{guid}.md` → body starts `# Title`.
   - `curl -I https://storage.googleapis.com/nstepro-sites/grimace/images/{img}` → correct `Content-Type`, `Cache-Control`.
   - Load `/grimace/note/{guid}` in a browser → title, TOC, hero image all render.
   - Re-run publisher → scratch note is skipped (mtime gate works, no duplicate work).
   - `gcloud storage rm` the scratch objects.
3. **Re-publish one real note** (e.g. `90s-movies`) end-to-end and diff against the live object.
4. Confirm exit code and summary output on a forced failure (bad bucket name) — no more silent failure.

## 7. Execution order

1. Remediate the 15 notes (§5) — independent, unblocks correct rendering today.
2. `publishToS3.js` → `publishToGCS.js` + `package.json`/lockfile (§3).
3. `.env.example` + README rewrite (§4).
4. Smoke + regression pass (§6), delete throwaway scripts.
5. User action: `gcloud auth application-default login`; update the Obsidian Shell Commands plugin registration from `publishToS3.js` → `publishToGCS.js`.

## 8. Out of scope (flagged, not changed)

- The other utility scripts (no AWS usage).
- `Notes.jsx` encodeURI fix (§5) — lives in `nstepro-sites`.
- Any change to note content transforms (hashtags, git sync, embeds) beyond the retarget.
- S3 decommission — already covered by CUTOVER_RUNBOOK §6; this refactor is the prerequisite it was waiting on.
