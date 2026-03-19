import os from 'node:os';
import path from 'node:path';

export type ServicePlatform = 'darwin' | 'linux';

export interface ServiceDescriptor {
  platform: ServicePlatform;
  serviceName: string;
  targetPath: string;
  content: string;
  installHint: string;
  uninstallHint: string;
  startHint: string;
  stopHint: string;
  statusHint: string;
}

export interface ServiceTemplateInput {
  serviceName: string;
  cliScriptPath: string;
  nodeBinaryPath: string;
  workingDirectory: string;
  configPath?: string;
  logDirectory: string;
  platform?: NodeJS.Platform;
}

export function buildServiceDescriptor(input: ServiceTemplateInput): ServiceDescriptor {
  const platform = normalizePlatform(input.platform ?? process.platform);
  if (platform === 'darwin') {
    return buildLaunchdDescriptor(input);
  }
  if (platform === 'linux') {
    return buildSystemdDescriptor(input);
  }
  throw new Error(`Unsupported platform: ${input.platform ?? process.platform}`);
}

function buildLaunchdDescriptor(input: ServiceTemplateInput): ServiceDescriptor {
  const serviceName = input.serviceName;
  const launchAgentPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${serviceName}.plist`);
  const args = buildServeArgs(input);
  const stdoutPath = path.join(input.logDirectory, `${serviceName}.out.log`);
  const stderrPath = path.join(input.logDirectory, `${serviceName}.err.log`);

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(serviceName)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(input.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;

  return {
    platform: 'darwin',
    serviceName,
    targetPath: launchAgentPath,
    content,
    installHint: `launchctl bootstrap gui/$(id -u) ${shellQuote(launchAgentPath)}`,
    uninstallHint: `launchctl bootout gui/$(id -u) ${shellQuote(launchAgentPath)} && rm -f ${shellQuote(launchAgentPath)}`,
    startHint: `launchctl kickstart -k gui/$(id -u)/${serviceName}`,
    stopHint: `launchctl bootout gui/$(id -u)/${serviceName}`,
    statusHint: `launchctl print gui/$(id -u)/${serviceName}`,
  };
}

function buildSystemdDescriptor(input: ServiceTemplateInput): ServiceDescriptor {
  const serviceName = input.serviceName;
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', `${serviceName}.service`);
  const args = buildServeArgs(input).map(shellQuote).join(' ');
  const stdoutPath = path.join(input.logDirectory, `${serviceName}.out.log`);
  const stderrPath = path.join(input.logDirectory, `${serviceName}.err.log`);

  const content = `[Unit]
Description=飞鹊 (Feique)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${input.workingDirectory}
ExecStart=${args}
Restart=always
RestartSec=3
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}

[Install]
WantedBy=default.target
`;

  return {
    platform: 'linux',
    serviceName,
    targetPath: unitPath,
    content,
    installHint: `systemctl --user daemon-reload && systemctl --user enable --now ${serviceName}.service`,
    uninstallHint: `systemctl --user disable --now ${serviceName}.service && rm -f ${shellQuote(unitPath)} && systemctl --user daemon-reload`,
    startHint: `systemctl --user start ${serviceName}.service`,
    stopHint: `systemctl --user stop ${serviceName}.service`,
    statusHint: `systemctl --user status ${serviceName}.service`,
  };
}

function buildServeArgs(input: ServiceTemplateInput): string[] {
  const args = [input.nodeBinaryPath, input.cliScriptPath, 'serve'];
  if (input.configPath) {
    args.push('--config', input.configPath);
  }
  return args;
}

function normalizePlatform(platform: NodeJS.Platform): ServicePlatform {
  if (platform === 'darwin' || platform === 'linux') {
    return platform;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

function escapeXml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function shellQuote(input: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(input)) {
    return input;
  }
  return `'${input.replaceAll("'", `'"'"'`)}'`;
}
