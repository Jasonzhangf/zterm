import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CaptureRemoteScreenshotWithDaemonOptions {
  outputPath: string;
  timeoutMs: number;
}

export async function captureRemoteScreenshotWithDaemon(
  options: CaptureRemoteScreenshotWithDaemonOptions,
): Promise<{ outputPath: string }> {
  return await new Promise<{ outputPath: string }>((resolve, reject) => {
    const daemonBinary = (process.env.ZTERM_DAEMON_NATIVE || '').trim()
      || join(homedir(), '.zterm', 'bin', 'zterm-daemon');

    execFile(daemonBinary, ['capture-screen', options.outputPath], {
      timeout: options.timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const details = [error.message, stderr, stdout].filter(Boolean).join('\n');
        reject(new Error(details || 'daemon screenshot capture failed'));
        return;
      }
      resolve({ outputPath: options.outputPath });
    });
  });
}
