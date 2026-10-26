import { spawn } from 'node:child_process';

// Fire-and-forget: spawn detached so the parent CLI can exit while the app stays open.
export function openInApp(filePath, appPath) {
    const child = spawn(appPath, [filePath], { detached: true, stdio: 'ignore' });
    child.unref();
}
