const { exec } = require('child_process');
const fs = require('fs-extra');
const sharp = require('sharp');
const path = require('path');
const puppeteer = require('puppeteer');
const { marked } = require('marked');
const sass = require('node-sass');
const matter = require('gray-matter');
const { Parser } = require('commonmark');

const myArgs = process.argv.slice(2);
var parser = new Parser();

// Load configs
var configName = myArgs[0]==undefined?'arcMain':myArgs[0];
var fileName = myArgs[1];
const configText = fs.readFileSync(`./configs/${configName}.json`, 'utf8');
const config = JSON.parse(configText);

// Get paths
const baseVaultPath = config.baseVaultPath
    , imgDir = path.join(baseVaultPath, config.relativeImagePath)
    , cssPath = path.join(config.templatePath, "style.scss")
    , headerPath = path.join(config.templatePath, "header.html")
    , footerPath = path.join(config.templatePath, "footer.html")
    , bodyPath = path.join(config.templatePath, "body.html")
    , outputPath = config.outputPath;

async function convertMarkdownToPDF(markdownFilePath, renderers) {

    try {
        // Read Markdown file
        let fileContent = await fs.readFile(markdownFilePath, 'utf8');
        let { data: frontMatter, content: markdown } = matter(fileContent);

        // Process images
        markdown = await convertImagesToBase64(markdown);
        fs.writeFileSync("./output.html", markdown);

        // Add title

        // Get TOC and Title
        let tocText = buildTOC(markdown, frontMatter);
        let docTitle = path.parse(markdownFilePath).name;
        markdown = `# ${docTitle} \n --- \n${tocText.md} \n ${markdown}`;

        // Convert Markdown to HTML
        marked.use({ gfm: true, renderer: renderers });
        const html = marked(markdown);

        // Read the stylesheet
        const css = await compileSassToCSS(cssPath);

        // Combine HTML with the stylesheet
        let fullHtml = await fs.readFile(bodyPath, 'utf8');
        fullHtml = fullHtml.replaceAll('{css}', css).replaceAll('{html}', html);

        // Get header/footer
        let headerContent = await fs.readFile(headerPath, 'utf8');
        headerContent = headerContent.replaceAll('{title}', docTitle);
        let footerContent = await fs.readFile(footerPath, "utf8");
        footerContent = footerContent.replaceAll('{year}', (new Date()).getFullYear());

        await fs.writeFile('output.html', fullHtml, 'utf8');

        // Launch Puppeteer
        const browser = await puppeteer.launch({headless: "new"});
        const page = await browser.newPage();

        // Set HTML content
        await page.setContent(fullHtml, { waitUntil: 'networkidle0' });

        // Print to PDF
        pdfOutFile = path.join(outputPath, `${docTitle}.pdf`);
        await page.pdf({ 
            path: pdfOutFile, 
            margin: { top: '100px', right: '50px', bottom: '100px', left: '50px' },
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: headerContent,
            footerTemplate: footerContent
        });

        // Close the browser
        await browser.close();

        console.log(`PDF successfully created at ${pdfOutFile}`);
        openPdf(pdfOutFile);

    } catch (error) {
        console.error('Error during markdown to PDF conversion:', error);
    }
}

// RENDERERS
const renderers = {
    heading(text, level) {
        return `
                <h${level} id="${toAnchorId(text)}">
                    ${text}
                </h${level}>`;
      }
};

// LOCAL IMAGE HANDLING
async function convertImagesToBase64(markdown) {
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
    const maxWidth = 2000, imgQuality = 70;
    // Resize the image if wider than 1200px using sharp
    let buffer = await sharp(filePath)
        .metadata()
        .then(metadata => {
            if (metadata.width > maxWidth) {
                return sharp(filePath)
                    .resize(maxWidth) // Resize to max width
                    .png({ quality: imgQuality, force: false })
                    .jpeg({ quality: imgQuality, force: false })
                    .toBuffer();
            } else {
                return sharp(filePath)
                    .resize(metadata.width) // Resize to max width
                    .png({ quality: imgQuality, force: false })
                    .jpeg({ quality: imgQuality, force: false })
                    .toBuffer();
            }
        });

    return buffer.toString('base64');
}

// SASS/CSS RENDERING
async function compileSassToCSS(scssFilePath) {
    return new Promise((resolve, reject) => {
        sass.render({ file: scssFilePath }, (err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve(result.css.toString());
            }
        });
    });
}

// Function to open the PDF
function openPdf(filePath) {
    // Replace filePath with the path to your PDF file
    const pdfAppPath = config.pdfAppPath ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

    exec(`"${pdfAppPath}" "${filePath}"`, (err) => {
        if (err) {
            console.error(`An error occurred: ${err}`);
            return;
        }
        console.log('PDF opened with Chrome.');
    });
}

async function findFileByName(directory, fileName) {
    let files;
    try {
        files = await fs.readdir(directory, { withFileTypes: true });
    } catch (err) {
        throw err;
    }

    for (const file of files) {
        const filePath = path.join(directory, file.name);

        if (file.isDirectory()) {
            try {
                const foundPath = await findFileByName(filePath, fileName);
                if (foundPath) return foundPath;
            } catch (err) {
                console.error(err);
                continue;
            }
        } else if (file.name === fileName) {
            return filePath;
        }
    }

    return null;
}


(async () => {
    try {

        const filePath = await findFileByName(baseVaultPath, fileName);
        if (filePath) {
            console.log('File found:', filePath);
            convertMarkdownToPDF(filePath, renderers);
        } else {
            console.log('File not found');
        }
    } catch (err) {
        console.error('Error during search:', err);
    }
})();


function buildTOC(content, config) {
    try {
        let maxTOCLevel = config.maxTOC || 9999;
        // PARSE CONTENT AND PULL OUT TOC
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
        
        // ADD TITLE TO MD
        let md = '', sep = ' ';

        // CONVERT TO MD (KEEP ONLY DESIRED LEVELS)
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
    // Replace invalid symbols and spaces with underscores and convert to lowercase
    text = text.replace('&amp;', '&');
    return text.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}