import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServiceDescriptor } from '../src/service/templates.js';

describe('service templates', () => {
  it('builds a launchd plist on darwin', () => {
    const descriptor = buildServiceDescriptor({
      serviceName: 'feique',
      cliScriptPath: '/opt/feique/dist/cli.js',
      nodeBinaryPath: '/usr/local/bin/node',
      workingDirectory: '/workspace/project',
      configPath: '/workspace/project/.feique/config.toml',
      logDirectory: '/tmp/feique-logs',
      platform: 'darwin',
    });

    expect(descriptor.platform).toBe('darwin');
    expect(descriptor.targetPath).toBe(path.join(os.homedir(), 'Library', 'LaunchAgents', 'feique.plist'));
    expect(descriptor.content).toContain('<key>ProgramArguments</key>');
    expect(descriptor.content).toContain('/opt/feique/dist/cli.js');
    expect(descriptor.installHint).toContain('launchctl bootstrap');
  });

  it('builds a systemd user unit on linux', () => {
    const descriptor = buildServiceDescriptor({
      serviceName: 'feique',
      cliScriptPath: '/opt/feique/dist/cli.js',
      nodeBinaryPath: '/usr/bin/node',
      workingDirectory: '/workspace/project',
      logDirectory: '/tmp/feique-logs',
      platform: 'linux',
    });

    expect(descriptor.platform).toBe('linux');
    expect(descriptor.targetPath).toBe(path.join(os.homedir(), '.config', 'systemd', 'user', 'feique.service'));
    expect(descriptor.content).toContain('ExecStart=/usr/bin/node /opt/feique/dist/cli.js serve');
    expect(descriptor.installHint).toContain('systemctl --user enable --now');
  });
});
