const axios = require('axios');
const fs = require('fs');
const dotenv = require('dotenv');
const path = require('path');
const { convertMarkdownToHTML } = require('./markdownToHTML');
dotenv.config();
const myArgs = process.argv.slice(2);

// Configuration variables
var configName = myArgs[0]==undefined?'arcMain':myArgs[0];
var fileName = myArgs[1];const configText = fs.readFileSync(`./configs/${configName}.json`, 'utf8');
const config = JSON.parse(configText);

const apiUrl = `${process.env.CONFLUENCE_HOST || ''}/rest/api`;
const username = process.env.CONFLUENCE_USERNAME;
const apiToken = process.env.CONFLUENCE_API_TOKEN;
let spaceKey = process.env.CONFLUENCE_DEFAULT_SPACE;
let parentId = process.env.CONFLUENCE_DEFAULT_PARENT;

// Get paths
const baseVaultPath = config.baseVaultPath
    , imgDir = path.join(baseVaultPath, config.relativeImagePath)
    , cssPath = path.join(config.templatePath, "style.scss")
    , headerPath = path.join(config.templatePath, "header.html")
    , footerPath = path.join(config.templatePath, "footer.html")
    , bodyPath = path.join(config.templatePath, "body.html")
    , outputPath = config.outputPath;

// Encode credentials for basic auth
const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');

// Read markdown from file
async function readMarkdown(filePath) {
    const { html, headerTemplate, footerTemplate, title, frontMatter } = await convertMarkdownToHTML(filePath, {
        imgDir,
        cssPath,
        headerPath,
        footerPath,
        bodyPath
    });

    console.log(frontMatter);
    spaceKey = frontMatter["conf-space"] || spaceKey;
    parentId = frontMatter["conf-parent"] || parentId;

    // Add newline after each image tag
    return html.replace(/<img[^>]*>/g, '$&<br/>').replace(/<img/g, '<img style="max-width: 500px;"');
}

// Create a new Confluence page
async function createConfluencePage(title, content) {
    const url = `${apiUrl}/content`;
    const headers = {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };

    // Base data object without ancestors
    const data = {
        type: 'page',
        title: title,
        space: {
            key: spaceKey
        },
        body: {
            editor: {
                value: content,
                representation: 'editor' // Use 'editor' for the new Confluence editor
            }
        }
    };

    // Only add ancestors if parentId is defined and not empty
    if (parentId && parentId.trim() !== '') {
        data.ancestors = [{ 
            id: parentId.toString() // Ensure parentId is a string
        }];
    }

    try {
        console.log(url);
        const response = await axios.post(url, data, { headers: headers });
        return response.data;
    } catch (error) {
        if (error.response) {
            console.error('Error creating Confluence page:', error.response.data);
            console.error('Status code:', error.response.status);
        } else {
            console.error('Error:', error.message);
        }
        return null;
    }
}

// Add this new function to check if page exists
async function findConfluencePage(title) {
    const url = `${apiUrl}/content`;
    const headers = {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
    };
    
    try {
        const response = await axios.get(url, {
            headers,
            params: {
                spaceKey,
                parentId,
                title: title,
                expand: 'version'
            }
        });
        
        const results = response.data.results;
        return results.length > 0 ? results[0] : null;
    } catch (error) {
        console.error('Error finding page:', error.message);
        return null;
    }
}

// Add this new function to update existing page
async function updateConfluencePage(pageId, title, content, version) {
    const url = `${apiUrl}/content/${pageId}`;
    const headers = {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };
    
    const data = {
        version: {
            number: version + 1
        },
        title: title,
        type: 'page',
        body: {
            storage: {
                value: content,
                representation: 'storage'
            }
        }
    };

    try {
        const response = await axios.put(url, data, { headers });
        return response.data;
    } catch (error) {
        if (error.response) {
            console.error('Error updating Confluence page:', error.response.data);
            console.error('Status code:', error.response.status);
        } else {
            console.error('Error:', error.message);
        }
        return null;
    }
}

// Modify the uploadMarkdownToConfluence function
async function uploadMarkdownToConfluence(filePath, title) {
    try {
        const markdownContent = await readMarkdown(filePath);
        
        // Check if page already exists
        const existingPage = await findConfluencePage(title);
        
        let result;
        if (existingPage) {
            console.log(`Updating existing page: ${title}`);
            result = await updateConfluencePage(
                existingPage.id,
                title,
                markdownContent,
                existingPage.version.number
            );
        } else {
            console.log(`Creating new page: ${title}`);
            result = await createConfluencePage(title, markdownContent);
        }
        
        console.log(result ? 'Success!' : 'Operation failed.');
        return result;
    } catch (error) {
        console.error('Failed to read markdown file or upload content:', error);
        return null;
    }
}

async function findFileByName(directory, fileName) {
    let files;
    try {
        files = await fs.promises.readdir(directory, { withFileTypes: true });
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
            uploadMarkdownToConfluence(filePath, path.parse(fileName).name);
        } else {
            console.log('File not found');
        }
    } catch (err) {
        console.error('Error during search:', err);
    }
})(); 