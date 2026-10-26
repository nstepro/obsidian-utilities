import path from 'node:path';
import fs from 'node:fs';
import HTMLtoDOCX from 'html-to-docx';
import { convertMarkdownToHTML } from './lib/markdownToHTML.js';
import { parseArgs, loadConfig, loadWordOptions } from './lib/config.js';
import { findFileByName } from './lib/vault.js';
import { openInApp } from './lib/open.js';

const myArgs = process.argv.slice(2);
const { positional } = parseArgs(myArgs);

const configName = positional[0] === undefined ? 'arcMain' : positional[0];
const fileName = positional[1];
const { config, paths } = loadConfig(configName, fileName);
const { baseVaultPath, imgDir, cssPath, headerPath, footerPath, bodyPath, outputPath, wordAppPath } = paths;

// Load Word-specific config (per-template; missing file is a clear error)
const wordOptions = loadWordOptions(config.templatePath);

async function convertToWord(markdownFilePath) {
    try {
        // Convert markdown to HTML with all necessary components
        const { html, headerTemplate, footerTemplate, title } = await convertMarkdownToHTML(markdownFilePath, {
            imgDir,
            cssPath,
            headerPath,
            footerPath,
            bodyPath
        });

        // Configure Word document options
        const options = {
            title: title,
            header: false,
            footer: false,
            ...wordOptions
        };

        // Convert HTML to DOCX
        const docxBuffer = await HTMLtoDOCX(html, null, options);

        // Write the Word document
        const docxOutFile = path.join(outputPath, `${title}.docx`);
        await fs.promises.writeFile(docxOutFile, docxBuffer);

        console.log(`Word document successfully created at ${docxOutFile}`);
        openInApp(docxOutFile, wordAppPath);
        console.log('Word document opened with Microsoft Word.');
    } catch (error) {
        console.error('Error during markdown to Word conversion:', error);
    }
}

// Main execution
(async () => {
    try {
        const filePath = await findFileByName(baseVaultPath, fileName);
        if (filePath) {
            console.log('File found:', filePath);
            await convertToWord(filePath);
        } else {
            console.log('File not found');
        }
    } catch (err) {
        console.error('Error during search:', err);
    }
})();
