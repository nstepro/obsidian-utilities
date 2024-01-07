# obsidian-s3-private-publish
Method to publish select MD files to s3 repo with private GUID

## **How to use**
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
