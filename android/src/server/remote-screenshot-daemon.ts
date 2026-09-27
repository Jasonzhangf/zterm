import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runPhase3Screenshot } from './dagpipe-bridge';

export interface CaptureRemoteScreenshotWithDaemonOptions {
  outputPath: string;
  timeoutMs: number;
  sessionId?: string;
  windowId?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export async function captureRemoteScreenshotWithDaemon(
  options: CaptureRemoteScreenshotWithDaemonOptions,
): Promise<{ outputPath: string }> {
  const gate = runPhase3Screenshot({
    execution_id: `remote-screenshot:${Date.now()}`,
    attempt_id: '1',
    inputs: {
      'arc.screenshot_request': {
        sessionId: options.sessionId || 'daemon-screenshot',
        outputPath: options.outputPath,
      },
      'arc.screenshot_permission': { allowScreenshot: true },
    },
  });
  if (!gate.ok) {
    throw new Error(`dagpipe screenshot gate rejected capture: ${gate.error}`);
  }
  return await new Promise<{ outputPath: string }>((resolve, reject) => {
    const daemonBinary = (process.env.ZTERM_DAEMON_NATIVE || '').trim()
      || join(homedir(), '.zterm', 'bin', 'zterm-daemon');

    const args = ['capture-screen', options.outputPath];
    const windowId = options.windowId?.trim();
    if (windowId) {
      args.push('--window-id', windowId);
    }
    if (options.rect) {
      args.push(
        '--rect',
        [
          Math.round(options.rect.x),
          Math.round(options.rect.y),
          Math.round(options.rect.width),
          Math.round(options.rect.height),
        ].join(','),
      );
    }

    execFile(daemonBinary, args, {
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
