# Obsidian Utilities
Collection of utilities to turn Obsidian into a lightweight publishing platform.

## S3 Pretty Print
Converty your Obisidian Markdown files to PDF with highly customizable templates, with support for local image embedding, custom styling using SASS, and automatic header and footer generation.

### What It Does
The script takes a Markdown file as input and converts it to a PDF document. Key features include:
- **Local Image Embedding:** Converts local images referenced in the Markdown file to base64 and embeds them directly in the PDF.
- **Custom Styling:** Uses SASS for custom CSS styling of the PDF document.
- **Dynamic Header and Footer:** Generates headers and footers for each page, including dynamic content such as the current year.
- **Configurable Paths:** Allows configuration of paths for images, styles, templates, and output through a JSON file.

### How to Use
#### Configuration
1. **Install Dependencies:** Run `npm install` to install the required Node.js modules.
2. **Configuration File:** Create a JSON configuration file in the `configs` directory. The configuration should specify paths for images, styles, templates, and output. The following configurations are required:
    - **baseVaultPath**: The absolute path to your base Obsidian directory.
    - **relativeImagePath**: The path *relative to the base vault directory* that images are stored in.
    - **templatePath**: Path relative to the root directory of this repository that your template files are in. That directory must include four files: `body.html`, `footer.html`, `header.html` and `style.scss`.
    - **outputPath**: The absolute path where the generated PDF file should be saved.
    - **pdfAppPath**: The location of the application you want to open PDFs (e.g., Chrome or Adobe Acrobat Reader).

For example:

    ```json
    {
      "baseVaultPath": "path/to/markdown/files",
      "relativeImagePath": "path/to/images",
      "templatePath": "path/to/templates",
      "outputPath": "path/to/output",
      "pdfAppPath": "path/to/chrome.exe"
    }
    ```

#### Running the Script
Execute the script from the command line with:

```bash
node yourScriptName.js [configName] [fileName]
```

- **configName**: The name of your configuration file (minus the .json extension). Defaults to arcMain if not provided.
- **fileName**: The name of the Markdown file to convert.

#### Configuring in Obsidian
Using the [Shell Commands](https://github.com/Taitava/obsidian-shellcommands) plugin, register a new command that calls this script, passing in your template configuration (e.g., `arcMain`) and the name of the file ({{file_name}}):
```bash
node prettyPdf.js arcMain "{{file_name}}"
```

In the "Environments" config for Shell Commands, ensure the working directory is set to this Obsidian Utilities repository. 

Register a hotkey (e.g., `ctrl+P`), and invoke it from any active page. The resulting PDF will then open in Chrome.

### How It Works Technically
- **Markdown Parsing**: Uses gray-matter to parse front matter and marked for Markdown to HTML conversion.
- **Local Image Handling**: Replaces Obsidian-style image links with base64 encoded images using regular expressions and fs-extra for file operations.
- **SASS/CSS Rendering**: Compiles SASS to CSS using node-sass.
- **HTML and PDF Generation**: Assembles HTML with custom styling and uses puppeteer for generating the PDF file.
- **Dynamic Header/Footer**: Uses string replacement to insert dynamic content into headers and footers.


## S3 Publish
Method to publish select MD files to s3 repo with semi-private GUID.
### **Configure env variables.** 
Set up your env file with pointers for AWS, your local obsidian vault and (if using) the git repo information that you want to sync some files to.
- **AWS Pointers.** The primary purpose of the system is to sync files tagged in a local Obsidian vault to a specified S3 bucket with a new semi-private GUID.
  - **`AWS_ACCESS_KEY_ID`**. The access key for the AWS account that has write access to the target S3 bucket (e.g., `AKIAIOSFODNN7EXAMPLE`)
  - **`AWS_SECRET_ACCESS_KEY`**. The secret key for the AWS account that has write access to the target S3 bucket (e.g., `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`)
  - **`AWS_BUCKET_NAME`**. The bucket name that the data will be written to (all files will be written to the base path of the bucket) (e.g., `obsidian-notes`)
- **Obsidian Vault Pointers.** Configure which local directory to scan for files to publish.
  - **`BASE_MD_DIR`**. The absolute local file path of your obsidian vault. Technically, this can be any local path with markdown files in it. The service will crawl through ALL subdirectories to find markdown files that are tagged with a `publish` attribute in the front matter.
- **Git Pointers.** If desired, the system can also sync a further subset of files to a target git repository. This can be useful if a subdirectory in your Vault contains document data that you want to push to a gitdocs workflow.
  - **`GIT_PUBLISH_SUBDIR`**. The absolute local file system **path segments** that indicate the *parent directory* that contain the notes to push to git. When pushing to git, the directory structure nested *within* that parent directory will be persisted in the git repo. As an example - a user has product notes within `c:/Obsidian/Vaults/VaultABC/Tech/ProductDocs/` where `VaultABC` is the vault name. They could register `/ProductDocs/` i this configuration and any files within that path and its children would be synced to the git repo, with the folder structure. But the PARENT folder `ProductDocs` would not be created in the Git repo.
  - **`GIT_REPO_ABSDIR`**. The absolute local file path of the git repository. This can be the parent directory, (e.g., `c:/git/my-git-repo`) or a subdirectory that contains documentation for the repo (e.g., `c:/git/my-git-repo/docs`).
  - **`GIT_REPO_URL`**. When syncing the files, the system will also add a URL to the frontmatter of the file that can be used by a presentation app to link to the file on git. Specify the base URL that can be augmented with the file-specific path information to build the link to the file on git. Example: `https://github.com/myusername/my-git-repo/blob/main/docs`

### **Tag your markdown files.**
Only markdowns tagged appropriately will be updated and synced.
- **Tagging for AWS Sync.** Add a `publish:true` attribute to the frontmatter. Once the data is synced, a new `guid` attribute will appear that contains the file's unique ID (this is the name of the file in the S3 path). 
  - Note, if you do not want a GUID, and instead want a readable name, simply change the `guid` attribute to the desired name (but it MUST be unique for the bucket, as all files are placed in the base path) (e.g., `guid:vacation-notes`).
- **Tagging for Git Sync.** Add an empty `gitUrl` attribute to the frontmatter. Once the data is synced, this will be populated with the full git URL.

### **Executing the sync.**
The user must invoke the node app from the CLI (e.g., `node publish.js`). This can be put on a scheduler, or called with a shortcut from Obsidian using the [Shell Commands community plugin](https://publish.obsidian.md/shellcommands).
