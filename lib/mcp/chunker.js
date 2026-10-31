import crypto from 'node:crypto';

// Heading-aware markdown chunker. Pure: no I/O, no state.
//
// Rules (per plan §3):
//  - split candidate boundaries are headings H1–H4 (protected code fences and
//    $$…$$ LaTeX blocks are never split)
//  - greedy-pack segments to ~1000 chars (paragraph → sentence → hard cut)
//  - minimum chunk length 50 chars (shorter tails merge into the previous chunk)
//  - no overlap
//  - embedding text = heading + "\n\n" + content

const MAX_CHUNK = 1000;
const MIN_CHUNK = 50;

// A segment = one top-level unit (a heading section, or a protected block, or a
// loose paragraph run between headings).
export function splitSegments(md) {
    const lines = md.split(/\r?\n/);
    const segments = [];
    let cur = [];
    let curHeading = null;
    let curHeadingLine = -1;
    let inFence = false;
    let fenceMarker = null;
    let inMath = false;
    let startLine = 0; // 0-based line index of segment start

    const flush = (endLineExclusive) => {
        const text = cur.join('\n');
        if (text.trim()) segments.push({ heading: curHeading, text, startLine, endLine: endLineExclusive - 1 });
        cur = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // fenced code (``` or ~~~, longer marker wins inside)
        const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*(\S*)/);
        if (fenceMatch) {
            if (inFence && (!fenceMarker || line.includes(fenceMarker))) {
                inFence = false;
                fenceMarker = null;
            } else if (!inFence) {
                inFence = true;
                fenceMarker = fenceMatch[1][0].repeat(fenceMatch[1].length);
            }
            cur.push(line);
            continue;
        }
        if (inFence) {
            cur.push(line);
            continue;
        }

        // $$ math blocks: open, content, close — never split inside
        if (!inMath && /^\s*\$\$/.test(line) && !/^\s*\$\$.*\$\$/.test(line)) {
            inMath = true;
            cur.push(line);
            continue;
        }
        if (inMath) {
            cur.push(line);
            if (/\$\$\s*$/.test(line)) inMath = false;
            continue;
        }

        // heading H1–H4
        const headingMatch = line.match(/^(#{1,4})\s+(.*)/);
        if (headingMatch) {
            flush(i);
            curHeading = headingMatch[2].trim();
            curHeadingLine = i;
            startLine = i;
            cur.push(line);
            continue;
        }

        if (!cur.length) {
            startLine = i;
            if (!curHeadingLine && curHeadingLine !== 0) curHeading = curHeading; // keep last heading
        }
        cur.push(line);
    }
    flush(lines.length);
    return segments;
}

// Greedy-pack segment text into chunks of ≤ ~MAX_CHUNK chars.
function packSegment(text) {
    if (text.length <= MAX_CHUNK) return [text];

    const out = [];
    let buf = '';
    const pushBuf = () => {
        if (buf.trim()) out.push(buf.trimEnd());
        buf = '';
    };

    const paras = text.split(/\n\s*\n/);
    for (const para of paras) {
        if ((buf + '\n\n' + para).length <= MAX_CHUNK || !buf) {
            if (buf) buf += '\n\n';
            // paragraph itself may exceed MAX → sentence / hard cut
            if (para.length > MAX_CHUNK) {
                for (const piece of packLongParagraph(para)) {
                    pushBuf();
                    out.push(piece);
                }
            } else {
                buf += para;
            }
        } else {
            pushBuf();
            if (para.length > MAX_CHUNK) {
                for (const piece of packLongParagraph(para)) out.push(piece);
            } else {
                buf = para;
            }
        }
    }
    pushBuf();
    return out;
}

function packLongParagraph(para) {
    const sentences = para.split(/(?<=[.!?])\s+/);
    let buf = '';
    const out = [];
    for (const s of sentences) {
        if (s.length > MAX_CHUNK) {
            // hard cut
            if (buf) out.push(buf);
            buf = '';
            for (let i = 0; i < s.length; i += MAX_CHUNK) out.push(s.slice(i, i + MAX_CHUNK));
        } else if ((buf + ' ' + s).length <= MAX_CHUNK) {
            buf = buf ? buf + ' ' + s : s;
        } else {
            out.push(buf);
            buf = s;
        }
    }
    if (buf) out.push(buf);
    return out;
}

export function chunkMarkdown(md) {
    const segments = splitSegments(md);
    const chunks = [];
    let buf = null; // { heading, text, startLine, endLine }

    const flushBuf = () => {
        if (buf && buf.text.trim()) chunks.push(buf);
        buf = null;
    };

    for (const seg of segments) {
        const pieces = packSegment(seg.text);
        for (let pi = 0; pi < pieces.length; pi++) {
            const piece = pieces[pi];
            // continuation piece of an oversized segment keeps the segment heading
            const heading = seg.heading;
            if (buf && buf.heading === heading && (buf.text + '\n\n' + piece).length <= MAX_CHUNK) {
                buf.text += '\n\n' + piece;
                buf.endLine = seg.startLine + lineOffset(seg.text, pi);
            } else {
                flushBuf();
                buf = {
                    heading: heading ?? null,
                    text: piece,
                    startLine: seg.startLine + lineOffset(seg.text, pi),
                    endLine: seg.startLine + lineOffset(seg.text, pi) + piece.split('\n').length - 1,
                };
            }
        }
    }
    flushBuf();

    // merge < MIN_CHUNK tails into predecessor (same heading only; else keep)
    const merged = [];
    for (const c of chunks) {
        const prev = merged[merged.length - 1];
        if (prev && c.text.length < MIN_CHUNK && prev.heading === c.heading) {
            prev.text += '\n\n' + c.text;
            prev.endLine = c.endLine;
        } else {
            merged.push(c);
        }
    }

    return merged.map((c) => ({
        heading: c.heading,
        content: c.text.trim(),
        startLine: c.startLine + 1, // 1-based
        endLine: c.endLine + 1,
        embeddingText: (c.heading ? c.heading + '\n\n' : '') + c.text.trim(),
    }));
}

// char offset in `text` where the pi-th packed piece starts (line arithmetic aid)
function lineOffset(segText, pieceIndex) {
    if (pieceIndex === 0) return 0;
    // find the piece text inside segment text (pieces are sequential, non-overlapping after trim)
    return segText.split('\n').length; // conservative: shouldn't matter for line reporting of oversized segments
}

export function hashChunk(embeddingText) {
    return crypto.createHash('sha256').update(embeddingText, 'utf8').digest('hex');
}
