import { describe, expect, it } from 'vitest';
import { buildLaunchAgentPlistXml } from './launch-agent-plist';

describe('buildLaunchAgentPlistXml', () => {
  it('pins the daemon launch agent to GUI/Aqua session for screenshot-capable runtime', () => {
    const xml = buildLaunchAgentPlistXml({
      label: 'com.zterm.android.zterm-daemon',
      launchRunner: '/Users/fanzhang/.wterm/bin/zterm-daemon-launchd-run',
      stdoutPath: '/Users/fanzhang/.wterm/logs/launchd-stdout.log',
      stderrPath: '/Users/fanzhang/.wterm/logs/launchd-stderr.log',
    });

    expect(xml).toContain('<key>ProcessType</key>');
    expect(xml).toContain('<string>Interactive</string>');
    expect(xml).toContain('<key>LimitLoadToSessionType</key>');
    expect(xml).toContain('<string>Aqua</string>');
    expect(xml).toContain('/Users/fanzhang/.wterm/bin/zterm-daemon-launchd-run');
  });
});
