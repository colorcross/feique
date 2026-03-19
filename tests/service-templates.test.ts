import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServiceDescriptor } from '../src/service/templates.js';

describe('service templates', () => {
  it('builds a launchd plist on darwin', () => {
    const descriptor = buildServiceDescriptor({
      serviceName: 'feishu-bridge',
      cliScriptPath: '/opt/feishu-bridge/dist/cli.js',
      nodeBinaryPath: '/usr/local/bin/node',
      workingDirectory: '/workspace/project',
      configPath: '/workspace/project/.feishu-bridge/config.toml',
      logDirectory: '/tmp/feishu-bridge-logs',
      platform: 'darwin',
    });

    expect(descriptor.platform).toBe('darwin');
    expect(descriptor.targetPath).toBe(path.join(os.homedir(), 'Library', 'LaunchAgents', 'feishu-bridge.plist'));
    expect(descriptor.content).toContain('<key>ProgramArguments</key>');
    expect(descriptor.content).toContain('/opt/feishu-bridge/dist/cli.js');
    expect(descriptor.installHint).toContain('launchctl bootstrap');
  });

  it('builds a systemd user unit on linux', () => {
    const descriptor = buildServiceDescriptor({
      serviceName: 'feishu-bridge',
      cliScriptPath: '/opt/feishu-bridge/dist/cli.js',
      nodeBinaryPath: '/usr/bin/node',
      workingDirectory: '/workspace/project',
      logDirectory: '/tmp/feishu-bridge-logs',
      platform: 'linux',
    });

    expect(descriptor.platform).toBe('linux');
    expect(descriptor.targetPath).toBe(path.join(os.homedir(), '.config', 'systemd', 'user', 'feishu-bridge.service'));
    expect(descriptor.content).toContain('ExecStart=/usr/bin/node /opt/feishu-bridge/dist/cli.js serve');
    expect(descriptor.installHint).toContain('systemctl --user enable --now');
  });
});
