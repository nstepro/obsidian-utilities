const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');
const { convertMarkdownToHTML } = require('./markdownToHTML');
const dotenv = require('dotenv');

const myArgs = process.argv.slice(2);

// Load configs
dotenv.config();
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
    , outputPath = config.outputPath
    , pdfAppPath = process.env.PDF_APP_PATH ?? config.pdfAppPath ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

console.log(pdfAppPath);

async function convertToPDF(markdownFilePath) {
    try {
        // Convert markdown to HTML with all necessary components
        const { html, headerTemplate, footerTemplate, title } = await convertMarkdownToHTML(markdownFilePath, {
            imgDir,
            cssPath,
            headerPath,
            footerPath,
            bodyPath
        });

        // Launch Puppeteer
        const browser = await puppeteer.launch({headless: "new"});
        const page = await browser.newPage();

        // Set HTML content
        await page.setContent(html, { waitUntil: 'networkidle0' });

        // Print to PDF
        const pdfOutFile = path.join(outputPath, `${title}.pdf`);
        await page.pdf({ 
            path: pdfOutFile, 
            margin: { top: '100px', right: '50px', bottom: '100px', left: '50px' },
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: headerTemplate,
            footerTemplate: footerTemplate
        });

        // Close the browser
        await browser.close();

        console.log(`PDF successfully created at ${pdfOutFile}`);
        openPdf(pdfOutFile);

    } catch (error) {
        console.error('Error during markdown to PDF conversion:', error);
    }
}

// Function to open the PDF
function openPdf(filePath) {
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

// Main execution
(async () => {
    try {
        const filePath = await findFileByName(baseVaultPath, fileName);
        if (filePath) {
            console.log('File found:', filePath);
            convertToPDF(filePath);
        } else {
            console.log('File not found');
        }
    } catch (err) {
        console.error('Error during search:', err);
    }
})();