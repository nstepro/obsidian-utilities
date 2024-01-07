let extend = require('util')._extend;
let fs = require('fs');
let path = require('path');
let glob = require("glob");
const dotenv = require('dotenv');
let matter = require('gray-matter');
let short = require('short-uuid');
let AWS = require('aws-sdk');
const moment = require('moment');

// Get env variables
dotenv.config();
const baseDir = process.env.BASE_MD_DIR;
const s3Bucket = process.env.AWS_BUCKET_NAME;
const subDirForGit = process.env.GIT_PUBLISH_SUBDIR;
const gitPath = process.env.GIT_REPO_ABSDIR;
const gitURL = process.env.GIT_REPO_URL;
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const listAllKeys = (params, out = []) => new Promise((resolve, reject) => {
  s3.listObjectsV2(params).promise()
    .then(({Contents, IsTruncated, NextContinuationToken}) => {
      out.push(...Contents);
      !IsTruncated ? resolve(out) : resolve(listAllKeys(Object.assign(params, {ContinuationToken: NextContinuationToken}), out));
    })
    .catch(reject);
});


listAllKeys({Bucket: s3Bucket})
  .then((res)=>{
    objectMap = {};
    res.forEach((r)=>{
        objectMap[r.Key] = r.LastModified
    });
    mainFileLoop(objectMap)
  })
  .catch(console.log);


function mainFileLoop(objectMap) {
    // Loop through files
    glob(baseDir + '/**/*.md', (err,files) => {
        var fileList = [];
        files.forEach((file)=>{
            
            // Read front matter
            m = {};
            m.file = fs.readFileSync(file);
            m.matter = matter(m.file);

            // Get create/modify dates
            const createdDate = moment(fs.statSync(file).birthtime).format('MMM D, YYYY h:mm A');
            if (m.matter.data.created === undefined || m.matter.data.created === null) {
                m.matter.data.created = createdDate;
                fs.writeFileSync(file, matter.stringify(m.matter.content, m.matter.data));
            }

            // Git settings
            var gitSettings = {}
            gitSettings.gitPublish = (!(subDirForGit == null || gitPath == null) && file.indexOf(subDirForGit)>=0 && m.matter.data.gitURL !== undefined);
            gitSettings.curAbsDir = path.parse(file).dir;
            gitSettings.relDir = gitSettings.curAbsDir.substring(gitSettings.curAbsDir.indexOf(subDirForGit)+subDirForGit.length);
            gitSettings.gitAbsDir = gitPath+'/'+gitSettings.relDir;
            gitSettings.gitFileURL = gitURL+'/'+encodeURIComponent(gitSettings.relDir)+'/'+encodeURIComponent(path.parse(file).base);
            gitSettings.updateFile = false;

            // If publish tag is added
            if (m.matter.data.publish) {
                
                // If GUID doesn't already exist
                if (m.matter.data.guid === undefined) {
                    // Add new GUID tag
                    m.matter.data = extend(m.matter.data, {guid:short().new().substring(0,8)});
                    gitSettings.updateFile = true;
                }

                // Only proceed if updated since last S3 file (or S3 file doesn't exist)
                if (fs.statSync(file).mtime>objectMap[`${m.matter.data.guid}.md`] || objectMap[`${m.matter.data.guid}.md`]==undefined) {
                    console.log(`Processing modified file: ${path.parse(file).name}`);

                    // If GitURL doesn't exist (or is misaligned) - add it
                    if (gitSettings.gitPublish && gitSettings.gitFileURL !== m.matter.data.gitURL ) {
                        m.matter.data = extend(m.matter.data, {gitURL:gitSettings.gitFileURL});
                        gitSettings.updateFile = true;
                    }
                
                    // Update file in-place
                    if (gitSettings.updateFile) {
                        fs.writeFileSync(file, matter.stringify(m.matter.content, m.matter.data));
                    }

                    // CONTENT MODIFICATIONS
                    // Handle embedded images and markdown
                    m.matter.content = processEmbeds(m.matter.content, m.matter.data);

                    // Handle remaining links
                    m.matter.content = processRelativePathLinks(m.matter.content, file);

                    // S3/GIT SYNC
                    // Git Sync
                    if (gitSettings.gitPublish) {
                        var gitContent = m.matter.content;
                        gitContent = processGitImages(gitContent, gitSettings, file);

                        // Create path if not exists
                        if (!fs.existsSync(gitSettings.gitAbsDir)){
                            fs.mkdirSync(gitSettings.gitAbsDir, { recursive: true });
                        }

                        // Copy file
                        fs.writeFileSync(gitSettings.gitAbsDir+'/'+path.parse(file).base, matter.stringify(gitContent, null));
                    }

                    // Log for reporting
                    fileList.push({filename: path.basename(file), fileUpdated: gitSettings.updateFile, guid: m.matter.data.guid});

                    // Add title
                    m.matter.content = `# ${path.parse(file).name} \n --- \n`+m.matter.content;
                    
                    // Upload file to S3 (overwrite if exists)
                    uploadToS3(`${m.matter.data.guid}.md`,matter.stringify(m.matter.content, m.matter.data));
                }
            }
        });

    });
}


function uploadToS3(fileName, fileContent) {
    const params = {
        Bucket: s3Bucket,
        Key: fileName,
        Body: fileContent
    }
    s3.upload(params, (err, data) => {
        if (err) {
            console.log(err);
        }
    });
}

function processEmbeds(content, data) {
    var images = [];
    content.split('![[').forEach((str,i)=>{
        if (i>0) {
            images.push(str.split(']]')[0]);
        }
    });
    if (data.links != undefined) {
        data.links.forEach((link) => {
            images.push(link.img);
        });
    }

    images.forEach((imgName)=>{  
            // If not an image, treat as markdown embed and replace contents inline
            if (!imgName.match(/\.(jpg|jpeg|png|gif)$/i)) {
                glob.sync(baseDir + `/**/${imgName}.md`).forEach(file => {
                    var docData = fs.readFileSync(file);
                    docContent = matter(docData);
                    content = content.replace(new RegExp(`!\\[\\[${imgName}]]`, 'g'), docContent.content);
                });
            } 
            // Else upload the image
            else {
                glob.sync(baseDir + `/**/${imgName}`).forEach(file => {
                    var imgData = fs.readFileSync(file);
                    uploadToS3(imgName,imgData);
                });
            }
    })
    return content;
}

function processGitImages(content, gitSettings, file) {
    content.split('![[').forEach((str,i)=>{
        if (i>0) {
            var imgName = str.split(']]')[0];

            if (imgName.match(/\.(jpg|jpeg|png|gif)$/i)) {
                glob.sync(baseDir + `/**/${imgName}`).forEach(imgFile => {
                    
                    // Make images directory if not exists
                    var tgtFileDir = gitPath+'/images';
                    var tgtFileAbsPath = tgtFileDir+'/'+imgName;
                    var tgtFileRelPath = path.relative(gitSettings.relDir, 'images/'+imgName).replace(/\\/g, "/");
                    
                    if (!fs.existsSync(tgtFileDir)){
                        fs.mkdirSync(tgtFileDir);
                    }
                    fs.copyFileSync(imgFile, tgtFileAbsPath);
                    content = content.replace(new RegExp(`!\\[\\[${imgName}]]`, 'g'), `![${imgName}](${encodeURI(tgtFileRelPath)})`);
                });
            }
        }
    });
    return content;
}

function processRelativePathLinks(content, file) {
    content.split('[[').forEach((str,i)=>{
        if (i>0) {
            var linkName = str.split(']]')[0];
            if (!linkName.toLowerCase().startsWith("http")) {
                glob.sync(baseDir + `/**/${linkName}.md`).forEach(linkedFile => {
                    var relPath = path.relative(path.dirname(file), linkedFile).replace(/\\/g, "/");
                    content = content.replace(new RegExp(`\\[\\[${linkName}]]`, 'g'), `[${linkName}](${encodeURI(relPath)})`);
                });
            }
        }
    });
    return content;
}
