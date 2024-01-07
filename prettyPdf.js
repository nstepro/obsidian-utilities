const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');
const { marked } = require('marked');
const sass = require('node-sass');
const matter = require('gray-matter');

const myArgs = process.argv.slice(2);

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

        // Add title
        let docTitle = path.parse(markdownFilePath).name;
        markdown = `# ${docTitle} \n --- \n ${markdown}`;

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
const renderers = {};

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
    const imageBuffer = await fs.readFile(filePath);
    return imageBuffer.toString('base64');
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
    const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

    exec(`"${chromePath}" "${filePath}"`, (err) => {
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