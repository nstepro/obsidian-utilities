import fs from 'node:fs';
import { Jimp } from 'jimp';
import path from 'node:path';
import { Marked } from 'marked';
import matter from 'gray-matter';
import { Parser } from 'commonmark';
import sass from 'sass';
import cssMappings from './cssMappings.js';

// Initialize commonmark parser
const parser = new Parser();

// Marked instance with the custom heading renderer, registered ONCE at module
// scope (marked.use on the shared `marked` export mutates global state and
// compounded on every call).
const md = new Marked();
md.use({
    gfm: true,
    renderer: {
        // v13+ token-object signature. `this.parser.parseInline(token.tokens)`
        // yields the already-rendered inline HTML that v11 passed as `text`.
        heading(token) {
            const inner = this.parser.parseInline(token.tokens);
            return `<h${token.depth} id="${toAnchorId(inner)}">${inner}</h${token.depth}>`;
        },
        // v11 kept a blank line after a raw HTML block (page-break divs);
        // v18 swallows it. Re-add to preserve golden output parity.
        html(token) {
            return token.raw.endsWith('\n') ? token.raw : token.raw + '\n\n';
        }
    }
});

async function convertMarkdownToHTML(markdownFilePath, config) {
    // Read Markdown file
    let fileContent = await fs.promises.readFile(markdownFilePath, 'utf8');
    let { data: frontMatter, content: markdown } = matter(fileContent);

    // Process images
    markdown = await convertImagesToBase64(markdown, config.imgDir);

    // Process page break markers (---page--- or <!-- page -->)
    markdown = processPageBreaks(markdown);

    // Get TOC and Title
    let tocText = buildTOC(markdown, frontMatter);
    let docTitle = path.parse(markdownFilePath).name;
    
    // Add page break after TOC if specified in frontmatter
    let tocWithPageBreak = tocText.md;
    if (frontMatter.pageBreakAfterTOC === true || frontMatter.pageBreakAfterTOC === 'true') {
        tocWithPageBreak = tocText.md ? `${tocText.md}\n<div class="page-break"></div>\n` : '';
    }
    
    markdown = `# ${docTitle} \n --- \n${tocWithPageBreak}${markdown}`;

    // Convert Markdown to HTML
    let html = md.parse(markdown);

    // Wrap hashtags in spans
    html = wrapHashtags(html);

    // Read and compile the stylesheet
    let css = await compileSassToCSS(config.cssPath);

    // Generate custom CSS from frontmatter and append to compiled CSS
    const customCSS = generateCustomCSS(frontMatter);
    if (customCSS) {
        css += '\n/* Custom CSS from frontmatter */\n' + customCSS;
    }

    // Combine HTML with the stylesheet and templates
    let fullHtml = await fs.promises.readFile(config.bodyPath, 'utf8');
    fullHtml = fullHtml.replaceAll('{css}', css).replaceAll('{html}', html);

    // Remove script tags and their contents
    fullHtml = fullHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // Get header/footer
    let headerContent = await fs.promises.readFile(config.headerPath, 'utf8');
    headerContent = headerContent.replaceAll('{title}', docTitle);
    let footerContent = await fs.promises.readFile(config.footerPath, "utf8");
    footerContent = footerContent.replaceAll('{year}', (new Date()).getFullYear());

    return {
        html: fullHtml,
        headerTemplate: headerContent,
        footerTemplate: footerContent,
        title: docTitle,
        frontMatter: frontMatter
    };
}

async function convertImagesToBase64(markdown, imgDir) {
    const obsidianImageRegex = /!\[\[(.*?)\]\]/g;
    let match;
    let markdownProcessed = markdown;

    while ((match = obsidianImageRegex.exec(markdown)) !== null) {        
        const imagePath = match[1];
        const absoluteImagePath = path.join(imgDir, imagePath); 
        const imageBase64 = await imageToBase64(absoluteImagePath);
        const imageDataUri = `![${imagePath}](data:image/png;base64,${imageBase64})`;
        markdownProcessed = markdownProcessed.replace(match[0], imageDataUri);
    }

    return markdownProcessed;
}

async function imageToBase64(filePath) {
    const maxWidth = 2000;
    const imgQuality = 70;

    try {
        // Read the image
        const image = await Jimp.read(filePath);

        // Resize if needed (height auto-scales; Jimp.AUTO is gone in v1)
        if (image.width > maxWidth) {
            image.resize({ w: maxWidth });
        }

        // Determine output format based on file extension
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = ['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg' : 'image/png';

        // v1: quality is a JPEG encode option passed to getBuffer (0-100)
        const encodeOptions = mimeType === 'image/jpeg' ? { quality: imgQuality } : undefined;
        const buffer = await image.getBuffer(mimeType, encodeOptions);
        return buffer.toString('base64');
    } catch (error) {
        console.error(`Error processing image ${filePath}:`, error);
        throw error;
    }
}

async function compileSassToCSS(scssFilePath) {
    const result = await sass.compileAsync(scssFilePath);
    return result.css;
}

function generateCustomCSS(frontMatter) {
    if (!frontMatter) {
        return '';
    }

    let customCSS = '';
    let cssData = {};

    // Check if there's a nested 'css' object
    if (frontMatter.css && typeof frontMatter.css === 'object') {
        cssData = frontMatter.css;
    } else {
        // Extract flat keys that start with 'css' prefix
        Object.keys(frontMatter).forEach(key => {
            if (key.startsWith('css') && key.length > 3) {
                // Remove 'css' prefix and convert to camelCase
                const cssKey = key.substring(3);
                // Convert first letter to lowercase if needed
                const normalizedKey = cssKey.charAt(0).toLowerCase() + cssKey.slice(1);
                cssData[normalizedKey] = frontMatter[key];
            }
        });
    }

    // Generate CSS rules from the collected data
    Object.keys(cssData).forEach(key => {
        const value = cssData[key];
        if (value !== null && value !== undefined && value !== '') {
            const mapping = cssMappings[key];
            if (mapping && typeof mapping === 'function') {
                customCSS += mapping(value) + '\n';
            }
        }
    });

    return customCSS;
}

function buildTOC(content, config) {
    try {
        let maxTOCLevel = config.maxTOC || 9999;
        var parsed = parser.parse(content);
        var toc = [];
        var tocIdx = 0;
        var walker = parsed.walker();
        var event, node;
        
        while ((event = walker.next())) {
            node = event.node;
            if (event.entering && node.type === 'heading') {
                var h = node.firstChild;
                var hContent = h.literal;
                while(h.next !== null) {
                    h = h.next;
                    hContent = hContent + h.literal;
                }
                toc.push({
                    idx: tocIdx,
                    level: node.level,
                    title: hContent
                })
                tocIdx++;
            }
        }
        
        let md = '', sep = ' ';
        toc = toc.filter((d)=>{return d.level <= maxTOCLevel});
        
        if (toc.length>0) {
            var minLevel = toc.reduce(function(prev, curr) {
                return prev.level < curr.level ? prev : curr;
            }).level;
            
            toc.forEach(t=>{
                md = `${md}${sep.repeat(((t.level-(minLevel-1))*2))}- [${t.title}](#${toAnchorId(t.title)}) \n`;
            });
        }
        return {data: toc, md: md}
    } catch(e) {
        console.log(e);
        return {data: null, md: ""}
    }
}

function toAnchorId(text) {
    text = text.replace('&amp;', '&');
    return text.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

function processPageBreaks(markdown) {
    // Replace page break markers with HTML divs that will be preserved through markdown conversion
    // Supports both ---page--- and <!-- page --> syntax
    markdown = markdown.replace(/^---page---$/gm, '<div class="page-break"></div>');
    markdown = markdown.replace(/<!--\s*page\s*-->/gi, '<div class="page-break"></div>');
    return markdown;
}

function wrapHashtags(html) {
    // Pattern to match hashtags: # followed by word characters (alphanumeric, underscore, hyphen)
    // This will match #word, #hashtag, #tag-name, etc.
    // Headers are already converted to <h1>, <h2>, etc. by markdown, so we don't need to worry about those
    
    // First, protect already-wrapped hashtags and HTML tags from being processed
    const placeholders = [];
    let placeholderIndex = 0;
    
    // Protect existing hashtag spans (handle Unicode characters)
    html = html.replace(/<span class="hashtag">[^<]*<\/span>/gu, (match) => {
        const placeholder = `__HASHTAG_PLACEHOLDER_${placeholderIndex}__`;
        placeholders.push({ placeholder, original: match });
        placeholderIndex++;
        return placeholder;
    });
    
    // Protect HTML tags (content inside <...>)
    html = html.replace(/<[^>]+>/g, (match) => {
        const placeholder = `__TAG_PLACEHOLDER_${placeholderIndex}__`;
        placeholders.push({ placeholder, original: match });
        placeholderIndex++;
        return placeholder;
    });
    
    // Protect HTML entities (like &#123; or &amp;)
    html = html.replace(/&[#\w]+;/g, (match) => {
        const placeholder = `__ENTITY_PLACEHOLDER_${placeholderIndex}__`;
        placeholders.push({ placeholder, original: match });
        placeholderIndex++;
        return placeholder;
    });
    
    // Now match hashtags in the remaining text
    // Match #word where word consists of Unicode letters, numbers, underscores, or hyphens
    // Using \p{L} for Unicode letters and \p{N} for Unicode numbers (requires 'u' flag)
    html = html.replace(/#([\p{L}\p{N}_-]+)/gu, (match, tagName) => {
        return `<span class="hashtag">#${tagName}</span>`;
    });
    
    // Restore all placeholders in reverse order (to avoid conflicts)
    // Sort by placeholder length (longer first) to avoid partial matches
    placeholders.sort((a, b) => b.placeholder.length - a.placeholder.length);
    placeholders.forEach(({ placeholder, original }) => {
        html = html.replace(placeholder, original);
    });
    
    return html;
}

export {
    convertMarkdownToHTML
};