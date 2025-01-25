const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const HTMLtoDOCX = require('html-to-docx');
const { convertMarkdownToHTML } = require('./markdownToHTML');
const { spawn } = require('child_process');

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

// Load Word-specific config
const wordConfigPath = path.join(config.templatePath, "msword.json");
const wordConfig = fs.readFileSync(wordConfigPath, 'utf8');
const wordOptions = JSON.parse(wordConfig);

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
        await fs.writeFile(docxOutFile, docxBuffer);

        console.log(`Word document successfully created at ${docxOutFile}`);
        openWord(docxOutFile);

    } catch (error) {
        console.error('Error during markdown to Word conversion:', error);
    }
}

// Function to open the Word document
function openWord(filePath) {
    const wordAppPath = config.wordAppPath ?? 'C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE';

    // Use spawn instead of exec to avoid waiting for process completion
    const child = spawn(wordAppPath, [filePath], {
        detached: true,
        stdio: 'ignore'
    });

    // Unref the child process so parent can exit
    child.unref();

    console.log('Word document opened with Microsoft Word.');
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
            convertToWord(filePath);
        } else {
            console.log('File not found');
        }
    } catch (err) {
        console.error('Error during search:', err);
    }
})(); 