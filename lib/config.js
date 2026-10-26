import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

export function parseArgs(argv, { flags = [] } = {}) {
    const flagSet = Object.fromEntries(flags.map((f) => [f, argv.includes(f)]));
    const positional = argv.filter((a) => !a.startsWith('--'));
    return { ...flagSet, positional };
}

export function loadConfig(configName = 'arcMain', fileName) {
    const configText = fs.readFileSync(path.join('configs', `${configName}.json`), 'utf8');
    const config = JSON.parse(configText);
    const baseVaultPath = config.baseVaultPath;
    const paths = {
        baseVaultPath,
        imgDir: path.join(baseVaultPath, config.relativeImagePath),
        cssPath: path.join(config.templatePath, 'style.scss'),
        headerPath: path.join(config.templatePath, 'header.html'),
        footerPath: path.join(config.templatePath, 'footer.html'),
        bodyPath: path.join(config.templatePath, 'body.html'),
        outputPath: config.outputPath,
        pdfAppPath: process.env.PDF_APP_PATH ?? config.pdfAppPath,
        wordAppPath: config.wordAppPath ?? 'C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE',
    };
    return { config, paths, fileName };
}

// Word options are per-template; missing file is a CONFIG ERROR, not a crash.
export function loadWordOptions(templatePath) {
    const p = path.join(templatePath, 'msword.json');
    if (!fs.existsSync(p)) {
        throw new Error(`Missing ${p} — template must include msword.json`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}
