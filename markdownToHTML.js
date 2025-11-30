const fs = require('fs-extra');
const Jimp = require('jimp');
const path = require('path');
const { marked } = require('marked');
const matter = require('gray-matter');
const { Parser } = require('commonmark');
const sass = require('sass');

// Initialize commonmark parser
const parser = new Parser();

// Custom renderer for headings with anchor IDs
const renderers = {
    heading(text, level) {
        return `<h${level} id="${toAnchorId(text)}">${text}</h${level}>`;
    }
};

async function convertMarkdownToHTML(markdownFilePath, config) {
    // Read Markdown file
    let fileContent = await fs.readFile(markdownFilePath, 'utf8');
    let { data: frontMatter, content: markdown } = matter(fileContent);

    // Process images
    markdown = await convertImagesToBase64(markdown, config.imgDir);

    // Get TOC and Title
    let tocText = buildTOC(markdown, frontMatter);
    let docTitle = path.parse(markdownFilePath).name;
    markdown = `# ${docTitle} \n --- \n${tocText.md} \n ${markdown}`;

    // Convert Markdown to HTML
    marked.use({ gfm: true, renderer: renderers });
    const html = marked(markdown);

    // Read and compile the stylesheet
    const css = await compileSassToCSS(config.cssPath);

    // Combine HTML with the stylesheet and templates
    let fullHtml = await fs.readFile(config.bodyPath, 'utf8');
    fullHtml = fullHtml.replaceAll('{css}', css).replaceAll('{html}', html);

    // Remove script tags and their contents
    fullHtml = fullHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // Get header/footer
    let headerContent = await fs.readFile(config.headerPath, 'utf8');
    headerContent = headerContent.replaceAll('{title}', docTitle);
    let footerContent = await fs.readFile(config.footerPath, "utf8");
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
        const originalWidth = image.getWidth();
        
        // Resize if needed
        if (originalWidth > maxWidth) {
            image.resize(maxWidth, Jimp.AUTO);
        }
        
        // Determine output format based on file extension
        const ext = path.extname(filePath).toLowerCase();
        let mimeType = Jimp.MIME_PNG;
        
        // Convert to appropriate format and get buffer
        if (ext === '.jpg' || ext === '.jpeg') {
            mimeType = Jimp.MIME_JPEG;
            const buffer = await image.quality(imgQuality).getBufferAsync(mimeType);
            return buffer.toString('base64');
        } else {
            // For PNG and other formats, use PNG
            const buffer = await image.getBufferAsync(mimeType);
            return buffer.toString('base64');
        }
    } catch (error) {
        console.error(`Error processing image ${filePath}:`, error);
        throw error;
    }
}

async function compileSassToCSS(scssFilePath) {
    const result = await sass.compileAsync(scssFilePath);
    return result.css;
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

module.exports = {
    convertMarkdownToHTML
}; 