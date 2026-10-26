import path from 'node:path';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { convertMarkdownToHTML } from './lib/markdownToHTML.js';
import { parseArgs, loadConfig } from './lib/config.js';
import { findFileByName } from './lib/vault.js';
import { openInApp } from './lib/open.js';

const myArgs = process.argv.slice(2);
const parsed = parseArgs(myArgs, { flags: ['--save-html', '--html'] });
const saveHtml = parsed['--save-html'] || parsed['--html'];
const positional = parsed.positional;

const configName = positional[0] === undefined ? 'arcMain' : positional[0];
const fileName = positional[1];
const { paths } = loadConfig(configName, fileName);
const { baseVaultPath, imgDir, cssPath, headerPath, footerPath, bodyPath, outputPath } = paths;
const pdfAppPath = paths.pdfAppPath ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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
        const browser = await puppeteer.launch({headless: true});
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

        // Save HTML if requested
        if (saveHtml) {
            const htmlOutFile = path.join(outputPath, `${title}.html`);
            await fs.promises.writeFile(htmlOutFile, html, 'utf8');
            console.log(`HTML successfully saved at ${htmlOutFile}`);
        }

        // Close the browser
        await browser.close();

        console.log(`PDF successfully created at ${pdfOutFile}`);
        if (pdfAppPath) {
            openInApp(pdfOutFile, pdfAppPath);
            console.log('PDF opened with Chrome.');
        }
    } catch (error) {
        console.error('Error during markdown to PDF conversion:', error);
    }
}

// Main execution
(async () => {
    try {
        const filePath = await findFileByName(baseVaultPath, fileName);
        if (filePath) {
            console.log('File found:', filePath);
            await convertToPDF(filePath);
        } else {
            console.log('File not found');
        }
    } catch (err) {
        console.error('Error during search:', err);
    }
})();
