import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildScreenshotHelperLaunchAgentPlistXml } from './screenshot-helper-launch-agent.js';

describe('buildScreenshotHelperLaunchAgentPlistXml', () => {
  it('pins helper launch agent to GUI session and launches the helper runner script', () => {
    const xml = buildScreenshotHelperLaunchAgentPlistXml({
      label: 'com.zterm.mac.screenshot-helper',
      launchRunner: '/Users/fanzhang/.wterm/bin/zterm-screenshot-helper-run',
      stdoutPath: '/Users/fanzhang/.wterm/logs/screenshot-helper-stdout.log',
      stderrPath: '/Users/fanzhang/.wterm/logs/screenshot-helper-stderr.log',
    });

    assert.ok(xml.includes('<string>com.zterm.mac.screenshot-helper</string>'));
    assert.ok(xml.includes('<string>/Users/fanzhang/.wterm/bin/zterm-screenshot-helper-run</string>'));
    assert.ok(xml.includes('<key>RunAtLoad</key>'));
    assert.ok(xml.includes('<string>Interactive</string>'));
    assert.ok(xml.includes('<string>Aqua</string>'));
  });
});
