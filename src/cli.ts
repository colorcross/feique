#!/usr/bin/env node
import fs from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { createLogger } from './logging.js';
import { buildInitialConfig, getInitTargetPath } from './config/init.js';
import { getGlobalConfigPath } from './config/paths.js';
import { fileExists, writeUtf8Atomic } from './utils/fs.js';
import { findNearestProjectConfig, loadBridgeConfig, loadRuntimeConfig } from './config/load.js';
import { SessionStore } from './state/session-store.js';
import { AuditLog } from './state/audit-log.js';
import { RunStateStore } from './state/run-state-store.js';
import { FeishuClient } from './feishu/client.js';
import { FeishuBridgeService } from './bridge/service.js';
import { startLongConnectionBridge } from './feishu/long-connection.js';
import { startWebhookBridge } from './feishu/webhook.js';
import { bindProjectAlias, createProjectAlias } from './config/mutate.js';
import type { BridgeConfig, SandboxMode } from './config/schema.js';
import { findMissingEnvRefs, formatDoctorFinding, hasDoctorErrors, runDoctor, runRemoteDoctor } from './config/doctor.js';
import { installBundledCodexSkill } from './config/codex-skill.js';
import { buildServiceDescriptor } from './service/templates.js';
import { installServiceFile, resolveDefaultLogDirectory, uninstallServiceFile } from './service/install.js';
import { acquireInstanceLock } from './runtime/instance-lock.js';
import { formatFeishuInspect, inspectFeishuEnvironment } from './feishu/diagnostics.js';
import { MetricsRegistry } from './observability/metrics.js';
import { startMetricsServer } from './observability/server.js';
import { ServiceReadinessProbe } from './observability/readiness.js';
import { buildReplayCardAction, buildReplayMessageEvent, postWebhookPayload, requestWebhookEndpoint } from './feishu/replay.js';
import { isProcessAlive, terminateProcess } from './runtime/process.js';
import { startMcpServer } from './mcp/server.js';
import { getProjectArchiveDir, getProjectAuditDir } from './projects/paths.js';
import { expandHomePath } from './utils/path.js';

const logger = createLogger();
const program = new Command();

interface RuntimeCliConfig {
  service: {
    name: string;
    log_tail_lines: number;
    log_rotate_max_bytes: number;
    log_rotate_keep_files: number;
  };
  storage: {
    dir: string;
  };
}

program
  .name('feishu-bridge')
  .description('Feishu bridge for Codex CLI with session routing and project-scoped config.')
  .version(packageJson.version);

program
  .command('init')
  .description('Create a global or project-scoped config file')
  .option('--mode <mode>', 'global or project', 'global')
  .option('--force', 'overwrite existing config', false)
  .action(async (options: { mode: 'global' | 'project'; force: boolean }) => {
    const targetPath = getInitTargetPath(options.mode, process.cwd());
    if (!options.force && (await fileExists(targetPath))) {
      throw new Error(`Config already exists: ${targetPath}`);
    }

    const content = buildInitialConfig(options.mode, process.cwd());
    await writeUtf8Atomic(targetPath, content);
    console.log(`Wrote ${targetPath}`);
  });

const serveCommand = program
  .command('serve [operation]')
  .description('Start the Feishu bridge service')
  .option('--config <path>', 'config path override')
  .option('--detach', 'run the bridge in the background and return immediately', false)
  .option('--skip-doctor', 'skip startup doctor preflight', false)
  .option('--json', 'print runtime management commands as JSON', false)
  .option('--lines <number>', 'number of lines for `serve logs`')
  .option('--follow', 'follow appended log output for `serve logs`', false)
  .option('--rotate', 'rotate managed logs before printing `serve logs`', false)
  .option('--force', 'use SIGKILL if SIGTERM does not stop the process in time', false)
  .option('--wait-ms <number>', 'grace period for `serve stop`', '5000')
  .option('--all', 'show all runs for `serve ps`', false)
  .action(async (operation: string | undefined, options: { config?: string; detach: boolean; skipDoctor: boolean; json: boolean; lines?: string; follow: boolean; rotate: boolean; force: boolean; waitMs: string; all: boolean }) => {
    if (operation && operation !== 'start') {
      if (operation === 'status') {
        const { config } = await loadRuntimeConfig({ cwd: process.cwd(), configPath: options.config });
        const runtimeStatus = await inspectRuntimeStatus(config);
        if (options.json) {
          console.log(JSON.stringify(runtimeStatus, null, 2));
          return;
        }

        console.log(`service: ${config.service.name}`);
        console.log(`running: ${runtimeStatus.running}`);
        console.log(`pid: ${runtimeStatus.pid ?? '-'}`);
        console.log(`pid_file: ${runtimeStatus.pidPath}`);
        console.log(`log_file: ${runtimeStatus.logPath}`);
        console.log(`active_runs: ${runtimeStatus.activeRuns}`);
        return;
      }

      if (operation === 'stop') {
        const { config } = await loadRuntimeConfig({ cwd: process.cwd(), configPath: options.config });
        const runtimeStatus = await inspectRuntimeStatus(config);
        if (!runtimeStatus.pid || !runtimeStatus.running) {
          console.log('Bridge is not running.');
          return;
        }

        const stopped = await stopRuntimeProcess(runtimeStatus.pid, Number(options.waitMs), options.force);
        if (!stopped) {
          throw new Error(`Failed to stop bridge pid ${runtimeStatus.pid}`);
        }
        await fs.rm(runtimeStatus.pidPath, { force: true });
        console.log(`Stopped bridge pid ${runtimeStatus.pid}`);
        return;
      }

      if (operation === 'restart') {
        const { config } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
        const runtimeStatus = await inspectRuntimeStatus(config);
        if (runtimeStatus.pid && runtimeStatus.running) {
          const stopped = await stopRuntimeProcess(runtimeStatus.pid, Number(options.waitMs), options.force);
          if (!stopped) {
            throw new Error(`Failed to stop bridge pid ${runtimeStatus.pid}`);
          }
          await fs.rm(runtimeStatus.pidPath, { force: true });
        }
        const detached = await detachServeProcess({
          config,
          configPath: options.config,
          cwd: process.cwd(),
        });
        console.log(`Restarted bridge: pid=${detached.pid}`);
        console.log(`Log file: ${detached.logPath}`);
        console.log(`PID file: ${detached.pidPath}`);
        return;
      }

      if (operation === 'logs') {
        const { config } = await loadRuntimeConfig({ cwd: process.cwd(), configPath: options.config });
        const runtimePaths = getRuntimePaths(config);
        const lines = Number(options.lines ?? config.service.log_tail_lines);
        if (options.rotate) {
          const rotated = await rotateManagedLogs(config, { force: true });
          process.stdout.write(rotated.length > 0 ? `Rotated logs:\n${rotated.map((file) => `- ${file}`).join('\n')}\n` : 'No logs rotated.\n');
        }
        if (options.follow) {
          await followFile(runtimePaths.logPath, lines);
          return;
        }
        const content = await tailFile(runtimePaths.logPath, lines);
        process.stdout.write(content || 'No runtime log file found.\n');
        return;
      }

      if (operation === 'ps') {
        const { config } = await loadRuntimeConfig({ cwd: process.cwd(), configPath: options.config });
        const runStateStore = new RunStateStore(config.storage.dir);
        const runs = options.all ? await runStateStore.listRuns() : await runStateStore.listActiveRuns();
        console.log(JSON.stringify(runs, null, 2));
        return;
      }

      throw new Error(`Unknown serve operation: ${operation}`);
    }

    const { config, sources } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
    logger.info({ sources, transport: config.feishu.transport }, 'Loaded bridge config');
    const readiness = new ServiceReadinessProbe(config.service.name);
    readiness.markStarting(config.feishu.transport, { transport: config.feishu.transport });
    let findings = [] as Awaited<ReturnType<typeof runDoctor>>;

    if (!options.skipDoctor) {
      findings = await runDoctor(config);
      readiness.recordDoctorFindings(findings);
      for (const finding of findings) {
        const level = finding.level === 'error' ? 'error' : finding.level;
        logger[level]({ finding: finding.message }, 'Startup preflight');
      }
      if (hasDoctorErrors(findings)) {
        readiness.markDegraded('Doctor failed with blocking errors.');
        throw new Error('Doctor failed with blocking errors. Run `feishu-bridge doctor` to inspect the config.');
      }
    }

    if (options.detach) {
      const detached = await detachServeProcess({
        config,
        configPath: options.config,
        cwd: process.cwd(),
      });
      console.log(`Detached bridge started: pid=${detached.pid}`);
      console.log(`Log file: ${detached.logPath}`);
      console.log(`PID file: ${detached.pidPath}`);
      return;
    }

    const sessionStore = new SessionStore(config.storage.dir);
    const auditLog = new AuditLog(config.storage.dir);
    const metrics = new MetricsRegistry();
    const instanceLock = await acquireInstanceLock({
      storageDir: config.storage.dir,
      serviceName: config.service.name,
      transport: config.feishu.transport,
    });
    const feishuClient = new FeishuClient(config.feishu, logger, metrics);
    const mutableConfigPath = options.config ? path.resolve(options.config) : sources[0];
    const service = new FeishuBridgeService(config, feishuClient, sessionStore, auditLog, logger, metrics, undefined, undefined, undefined, undefined, {
      configPath: mutableConfigPath,
      restart: async () => {
        const detached = await detachServeProcess({
          config,
          ...(mutableConfigPath ? { configPath: mutableConfigPath } : {}),
          cwd: process.cwd(),
        });
        logger.warn({ newPid: detached.pid, configPath: mutableConfigPath }, 'Restarted bridge from admin command');
        setTimeout(() => {
          process.kill(process.pid, 'SIGTERM');
        }, 200);
      },
    });
    const recoveredRuns = await service.recoverRuntimeState();
    await service.runMaintenanceCycle();
    service.startMaintenanceLoop();
    const metricsServer =
      config.service.metrics_port !== undefined
        ? await startMetricsServer({
            host: config.service.metrics_host,
            port: config.service.metrics_port,
            serviceName: config.service.name,
            logger,
            metrics,
            readiness,
          })
        : undefined;

    const runtimePaths = getRuntimePaths(config);

    try {
      await fs.mkdir(config.storage.dir, { recursive: true });
      await fs.writeFile(runtimePaths.pidPath, `${process.pid}\n`, 'utf8');
      await auditLog.append({ type: 'service.start', transport: config.feishu.transport, sources, lock_path: instanceLock.lockPath });
      for (const recovered of recoveredRuns) {
        logger.warn({ runId: recovered.run_id, status: recovered.status, pid: recovered.pid }, 'Recovered run state on startup');
      }

      let stopSignal: NodeJS.Signals | undefined;
      try {
        if (config.feishu.transport === 'long-connection') {
          stopSignal = await startLongConnectionBridge({ config, service, feishuClient, logger, readiness });
          return;
        }

        stopSignal = await startWebhookBridge({ config, service, logger, readiness });
      } catch (error) {
        readiness.markDegraded(error instanceof Error ? error.message : String(error), { transport: config.feishu.transport });
        throw error;
      } finally {
        await auditLog.append({ type: 'service.stop', transport: config.feishu.transport, signal: stopSignal ?? 'unknown' });
      }
    } finally {
      readiness.markStopped({ transport: config.feishu.transport });
      service.stopMaintenanceLoop();
      if (metricsServer) {
        await metricsServer.close();
      }
      await instanceLock.release();
      await fs.rm(runtimePaths.pidPath, { force: true });
    }
  });

program
  .command('start')
  .description('Start the bridge in the background')
  .option('--config <path>', 'config path override')
  .action(async (options: { config?: string }) => {
    const { config } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
    const runtimeStatus = await inspectRuntimeStatus(config);
    if (runtimeStatus.pid && runtimeStatus.running) {
      console.log(`Bridge is already running: pid=${runtimeStatus.pid}`);
      return;
    }
    const detached = await detachServeProcess({
      config,
      configPath: options.config,
      cwd: process.cwd(),
    });
    console.log(`Started bridge: pid=${detached.pid}`);
    console.log(`Log file: ${detached.logPath}`);
    console.log(`PID file: ${detached.pidPath}`);
  });

program
  .command('stop')
  .description('Stop the bridge')
  .option('--config <path>', 'config path override')
  .option('--force', 'use SIGKILL if SIGTERM does not stop the process in time', false)
  .option('--wait-ms <number>', 'grace period before forcing stop', '5000')
  .action(async (options: { config?: string; force: boolean; waitMs: string }) => {
    const { config } = await loadRuntimeConfig({ cwd: process.cwd(), configPath: options.config });
    const runtimeStatus = await inspectRuntimeStatus(config);
    if (!runtimeStatus.pid || !runtimeStatus.running) {
      console.log('Bridge is not running.');
      return;
    }
    const stopped = await stopRuntimeProcess(runtimeStatus.pid, Number(options.waitMs), options.force);
    if (!stopped) {
      throw new Error(`Failed to stop bridge pid ${runtimeStatus.pid}`);
    }
    await fs.rm(runtimeStatus.pidPath, { force: true });
    console.log(`Stopped bridge pid ${runtimeStatus.pid}`);
  });

program
  .command('restart')
  .description('Restart the bridge in the background')
  .option('--config <path>', 'config path override')
  .option('--force', 'use SIGKILL if SIGTERM does not stop the process in time', false)
  .option('--wait-ms <number>', 'grace period before forcing stop', '5000')
  .action(async (options: { config?: string; force: boolean; waitMs: string }) => {
    const { config } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
    const runtimeStatus = await inspectRuntimeStatus(config);
    if (runtimeStatus.pid && runtimeStatus.running) {
      const stopped = await stopRuntimeProcess(runtimeStatus.pid, Number(options.waitMs), options.force);
      if (!stopped) {
        throw new Error(`Failed to stop bridge pid ${runtimeStatus.pid}`);
      }
      await fs.rm(runtimeStatus.pidPath, { force: true });
    }
    const detached = await detachServeProcess({
      config,
      configPath: options.config,
      cwd: process.cwd(),
    });
    console.log(`Restarted bridge: pid=${detached.pid}`);
    console.log(`Log file: ${detached.logPath}`);
    console.log(`PID file: ${detached.pidPath}`);
  });

program
  .command('status')
  .description('Print the current bridge runtime status')
  .option('--config <path>', 'config path override')
  .option('--json', 'print status as JSON', false)
  .action(async (options: { config?: string; json: boolean }) => {
    const { config } = await loadRuntimeConfig({ cwd: process.cwd(), configPath: options.config });
    const runtimeStatus = await inspectRuntimeStatus(config);
    if (options.json) {
      console.log(JSON.stringify(runtimeStatus, null, 2));
      return;
    }
    console.log(`service: ${config.service.name}`);
    console.log(`running: ${runtimeStatus.running}`);
    console.log(`pid: ${runtimeStatus.pid ?? '-'}`);
    console.log(`pid_file: ${runtimeStatus.pidPath}`);
    console.log(`log_file: ${runtimeStatus.logPath}`);
    console.log(`active_runs: ${runtimeStatus.activeRuns}`);
  });

program
  .command('logs')
  .description('Tail bridge logs')
  .option('--config <path>', 'config path override')
  .option('--lines <number>', 'number of lines to print')
  .option('--rotate', 'rotate managed logs before printing', false)
  .option('--follow', 'follow appended log output', false)
  .action(async (options: { config?: string; lines?: string; rotate: boolean; follow: boolean }) => {
    const { config } = await loadRuntimeConfig({ cwd: process.cwd(), configPath: options.config });
    const runtimePaths = getRuntimePaths(config);
    const lines = Number(options.lines ?? config.service.log_tail_lines);
    if (options.rotate) {
      const rotated = await rotateManagedLogs(config, { force: true });
      process.stdout.write(rotated.length > 0 ? `Rotated logs:\n${rotated.map((file) => `- ${file}`).join('\n')}\n` : 'No logs rotated.\n');
    }
    if (options.follow) {
      await followFile(runtimePaths.logPath, lines);
      return;
    }
    const content = await tailFile(runtimePaths.logPath, lines);
    process.stdout.write(content || 'No runtime log file found.\n');
  });

program
  .command('ps')
  .description('Print current run states')
  .option('--config <path>', 'config path override')
  .option('--all', 'show all runs instead of only active runs', false)
  .action(async (options: { config?: string; all: boolean }) => {
    const { config } = await loadRuntimeConfig({ cwd: process.cwd(), configPath: options.config });
    const runStateStore = new RunStateStore(config.storage.dir);
    const runs = options.all ? await runStateStore.listRuns() : await runStateStore.listActiveRuns();
    console.log(JSON.stringify(runs, null, 2));
  });

program
  .command('doctor')
  .description('Validate runtime prerequisites and config quality')
  .option('--config <path>', 'config path override')
  .option('--remote', 'run remote Feishu availability checks', false)
  .option('--fix', 'apply safe local fixes such as creating storage directories and rotating oversized logs', false)
  .option('--json', 'print findings as JSON', false)
  .action(async (options: { config?: string; json: boolean; remote: boolean; fix: boolean }) => {
    try {
      const { config } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
      if (options.fix) {
        const fixes = await applySafeDoctorFixes(config);
        if (fixes.length > 0 && !options.json) {
          for (const fix of fixes) {
            console.log(`[fix] ${fix}`);
          }
        }
      }
      const findings = await runDoctor(config);
      if (options.remote) {
        findings.push(...(await runRemoteDoctor(config)));
      }
      printDoctorFindings(findings, options.json);
      if (hasDoctorErrors(findings)) {
        process.exitCode = 1;
      }
      return;
    } catch (error) {
      const configPaths = await collectDoctorConfigPaths(process.cwd(), options.config);
      const findings = await findMissingEnvRefs(configPaths);
      const message = error instanceof Error ? error.message : String(error);
      findings.push({ level: 'error', message });
      printDoctorFindings(findings, options.json);
      process.exitCode = 1;
    }
  });

program
  .command('bind <alias> <root>')
  .description('Add or update a project alias in the config')
  .option('--config <path>', 'config path override')
  .option('--profile <profile>', 'Codex profile for this project')
  .option('--sandbox <sandbox>', 'Sandbox override for this project')
  .action(
    async (
      alias: string,
      root: string,
      options: { config?: string; profile?: string; sandbox?: SandboxMode },
    ) => {
      const projectConfigPath = options.config ? null : await findNearestProjectConfig(process.cwd());
      const configPath = options.config
        ? path.resolve(options.config)
        : projectConfigPath ?? getGlobalConfigPath();
      if (!(await fileExists(configPath))) {
        throw new Error(`Config file not found: ${configPath}`);
      }
      await bindProjectAlias({
        configPath,
        alias,
        root,
        profile: options.profile,
        sandbox: options.sandbox,
      });
      console.log(`Bound ${alias} -> ${path.resolve(expandHomePath(root))} in ${configPath}`);
    },
  );

program
  .command('create-project <alias> <root>')
  .description('Create a project directory and bind it as a new project alias')
  .option('--config <path>', 'config path override')
  .option('--profile <profile>', 'Codex profile for this project')
  .option('--sandbox <sandbox>', 'Sandbox override for this project')
  .action(
    async (
      alias: string,
      root: string,
      options: { config?: string; profile?: string; sandbox?: SandboxMode },
    ) => {
      const projectConfigPath = options.config ? null : await findNearestProjectConfig(process.cwd());
      const configPath = options.config
        ? path.resolve(options.config)
        : projectConfigPath ?? getGlobalConfigPath();
      if (!(await fileExists(configPath))) {
        throw new Error(`Config file not found: ${configPath}`);
      }
      const created = await createProjectAlias({
        configPath,
        alias,
        root,
        profile: options.profile,
        sandbox: options.sandbox,
      });
      console.log(`Created ${alias} -> ${created.root} in ${configPath}`);
    },
  );

program
  .command('upgrade')
  .description('Check or install the latest npm release of feishu-bridge')
  .option('--check', 'only print the latest available version', false)
  .option('--yes', 'install the latest release immediately', false)
  .action(async (options: { check: boolean; yes: boolean }) => {
    const latest = await fetchLatestPublishedVersion();
    console.log(`current: ${packageJson.version}`);
    console.log(`latest: ${latest}`);
    if (options.check || !options.yes) {
      if (!options.check) {
        console.log('Re-run with `feishu-bridge upgrade --yes` to install the latest npm release globally.');
      }
      return;
    }
    await installLatestPublishedVersion();
    console.log(`Upgraded feishu-bridge to ${latest}`);
  });

program
  .command('mcp')
  .description('Run an MCP server for external tools such as OpenClaw')
  .option('--config <path>', 'config path override')
  .option('--transport <transport>', 'stdio or http')
  .option('--host <host>', 'HTTP bind host')
  .option('--port <number>', 'HTTP bind port')
  .option('--path <path>', 'HTTP JSON-RPC path')
  .option('--sse-path <path>', 'HTTP SSE path')
  .option('--message-path <path>', 'HTTP SSE message POST path')
  .option('--auth-token <token>', 'HTTP Bearer token')
  .option('--auth-token-id <id>', 'logical token id used with --auth-token')
  .action(async (options: { config?: string; transport?: 'stdio' | 'http'; host?: string; port?: string; path?: string; ssePath?: string; messagePath?: string; authToken?: string; authTokenId?: string }) => {
    await startMcpServer({
      cwd: process.cwd(),
      configPath: options.config,
      transport: options.transport,
      host: options.host,
      port: options.port ? Number(options.port) : undefined,
      path: options.path,
      ssePath: options.ssePath,
      messagePath: options.messagePath,
      authToken: options.authToken,
      authTokenId: options.authTokenId,
    });
  });

const sessionsCommand = program.command('sessions').description('Inspect persisted session state');

sessionsCommand
  .command('list')
  .option('--config <path>', 'config path override')
  .action(async (options: { config?: string }) => {
    const { config } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
    const sessionStore = new SessionStore(config.storage.dir);
    const conversations = await sessionStore.listConversations();
    if (conversations.length === 0) {
      console.log('No sessions found.');
      return;
    }
    for (const [conversationKey, conversation] of conversations) {
      console.log(`${conversationKey}`);
      console.log(`  selected_project: ${conversation.selected_project_alias ?? '-'}`);
      for (const [projectAlias, session] of Object.entries(conversation.projects)) {
        console.log(`  - ${projectAlias}: ${session.thread_id ?? 'no-thread'} (${session.updated_at})`);
      }
    }
  });

sessionsCommand
  .command('clear <conversationKey>')
  .option('--config <path>', 'config path override')
  .action(async (conversationKey: string, options: { config?: string }) => {
    const { config } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
    const sessionStore = new SessionStore(config.storage.dir);
    await sessionStore.clearConversation(conversationKey);
    console.log(`Cleared ${conversationKey}`);
  });

const codexCommand = program.command('codex').description('Codex-side helpers');

codexCommand
  .command('install-skill')
  .description('Install the bundled Codex skill into ~/.codex/skills and enable it in ~/.codex/config.toml')
  .option('--name <name>', 'target skill name', 'feishu-bridge-session')
  .action(async (options: { name: string }) => {
    const skillSourceDir = path.resolve(process.cwd(), 'skills', 'feishu-bridge-session');
    if (!(await fileExists(skillSourceDir))) {
      throw new Error(`Bundled skill not found: ${skillSourceDir}`);
    }
    const result = await installBundledCodexSkill({ skillSourceDir, skillName: options.name });
    console.log(`Installed skill to ${result.skillPath}`);
    console.log(`Updated Codex config ${result.configPath}`);
  });

const feishuCommand = program.command('feishu').description('Feishu-side diagnostics and manual checks');

feishuCommand
  .command('inspect')
  .description('Inspect app/bot/IM availability using the configured Feishu credentials')
  .option('--config <path>', 'config path override')
  .option('--json', 'print raw JSON result', false)
  .action(async (options: { config?: string; json: boolean }) => {
    const { config } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
    const result = await inspectFeishuEnvironment(config.feishu);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.token.ok || !result.app.ok || !result.bot.ok || !result.chats_probe.ok) {
        process.exitCode = 1;
      }
      return;
    }

    console.log(formatFeishuInspect(result));
    if (!result.token.ok || !result.app.ok || !result.bot.ok || !result.chats_probe.ok) {
      process.exitCode = 1;
    }
  });

feishuCommand
  .command('send-test')
  .description('Send a real Feishu text message to a specific receive_id')
  .option('--config <path>', 'config path override')
  .requiredOption('--receive-id-type <type>', 'chat_id | open_id | user_id | union_id | email')
  .requiredOption('--receive-id <id>', 'target receive_id')
  .option('--text <text>', 'message text', 'feishu-bridge send-test')
  .action(
    async (options: {
      config?: string;
      receiveIdType: 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email';
      receiveId: string;
      text: string;
    }) => {
      const { config } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
      const client = new FeishuClient(config.feishu, logger);
      const response = await client.sendTextToReceiveId(options.receiveIdType, options.receiveId, options.text);
      console.log(JSON.stringify(response, null, 2));
    },
  );

const webhookCommand = program.command('webhook').description('Webhook replay helpers for local and staging E2E');

webhookCommand
  .command('replay-message')
  .description('Replay a receive-message event into a local webhook endpoint')
  .requiredOption('--url <url>', 'target event webhook URL')
  .requiredOption('--chat-id <id>', 'chat_id')
  .requiredOption('--actor-id <id>', 'sender open_id')
  .option('--text <text>', 'message text', 'hello from feishu-bridge replay')
  .option('--chat-type <type>', 'p2p or group', 'p2p')
  .option('--tenant-key <key>', 'tenant key', 'tenant-local')
  .action(
    async (options: {
      url: string;
      chatId: string;
      actorId: string;
      text: string;
      chatType: 'p2p' | 'group';
      tenantKey: string;
    }) => {
      const payload = buildReplayMessageEvent({
        chatId: options.chatId,
        actorId: options.actorId,
        text: options.text,
        chatType: options.chatType,
        tenantKey: options.tenantKey,
      });
      const response = await postWebhookPayload({ url: options.url, payload });
      console.log(JSON.stringify(response, null, 2));
    },
  );

webhookCommand
  .command('replay-card')
  .description('Replay an interactive card callback into a local webhook endpoint')
  .requiredOption('--url <url>', 'target card callback URL')
  .requiredOption('--chat-id <id>', 'chat_id')
  .requiredOption('--actor-id <id>', 'operator open_id')
  .requiredOption('--open-message-id <id>', 'open_message_id')
  .option('--action <action>', 'status | rerun | new', 'status')
  .option('--project-alias <alias>', 'project alias')
  .option('--conversation-key <key>', 'conversation key')
  .option('--tenant-key <key>', 'tenant key', 'tenant-local')
  .action(
    async (options: {
      url: string;
      chatId: string;
      actorId: string;
      openMessageId: string;
      action: string;
      projectAlias?: string;
      conversationKey?: string;
      tenantKey: string;
    }) => {
      const payload = buildReplayCardAction({
        chatId: options.chatId,
        actorId: options.actorId,
        openMessageId: options.openMessageId,
        action: options.action,
        tenantKey: options.tenantKey,
        projectAlias: options.projectAlias,
        conversationKey: options.conversationKey,
      });
      const response = await postWebhookPayload({ url: options.url, payload });
      console.log(JSON.stringify(response, null, 2));
    },
  );

webhookCommand
  .command('smoke')
  .description('Run a smoke test against healthz, event, and optional card callback')
  .requiredOption('--base-url <url>', 'base URL, for example http://127.0.0.1:3333')
  .option('--event-path <path>', 'event webhook path', '/webhook/event')
  .option('--card-path <path>', 'card callback path', '/webhook/card')
  .option('--chat-id <id>', 'chat_id', 'oc_smoke')
  .option('--actor-id <id>', 'sender/operator open_id', 'ou_smoke')
  .option('--tenant-key <key>', 'tenant key', 'tenant-local')
  .option('--project-alias <alias>', 'project alias for the card probe', 'default')
  .option('--message-text <text>', 'message text used during smoke', '/help')
  .option('--skip-card', 'skip the card callback probe', false)
  .option('--timeout-ms <number>', 'request timeout in milliseconds', '5000')
  .action(
    async (options: {
      baseUrl: string;
      eventPath: string;
      cardPath: string;
      chatId: string;
      actorId: string;
      tenantKey: string;
      projectAlias: string;
      messageText: string;
      skipCard: boolean;
      timeoutMs: string;
    }) => {
      const timeoutMs = Number(options.timeoutMs);
      const baseUrl = ensureTrailingSlash(options.baseUrl);
      const healthUrl = new URL('healthz', baseUrl).toString();
      const eventUrl = new URL(trimLeadingSlash(options.eventPath), baseUrl).toString();
      const cardUrl = new URL(trimLeadingSlash(options.cardPath), baseUrl).toString();
      const conversationKey = `${options.tenantKey}/${options.chatId}/${options.actorId}`;

      const health = await requestWebhookEndpoint({ url: healthUrl, method: 'GET', timeoutMs });
      const message = await postWebhookPayload({
        url: eventUrl,
        timeoutMs,
        payload: buildReplayMessageEvent({
          chatId: options.chatId,
          actorId: options.actorId,
          chatType: 'p2p',
          text: options.messageText,
          tenantKey: options.tenantKey,
        }),
      });
      const card = options.skipCard
        ? undefined
        : await postWebhookPayload({
            url: cardUrl,
            timeoutMs,
            payload: buildReplayCardAction({
              chatId: options.chatId,
              actorId: options.actorId,
              openMessageId: 'om_smoke',
              action: 'status',
              tenantKey: options.tenantKey,
              projectAlias: options.projectAlias,
              conversationKey,
            }),
          });

      const summary = {
        ok: health.statusCode === 200 && message.statusCode === 200 && (options.skipCard || card?.statusCode === 200),
        health,
        message,
        ...(card ? { card } : {}),
      };
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.ok) {
        process.exitCode = 1;
      }
    },
  );



const auditCommand = program.command('audit').description('Inspect structured audit events');

auditCommand
  .command('tail')
  .description('Print the latest audit events as JSON')
  .option('--config <path>', 'config path override')
  .option('--limit <number>', 'number of events', '20')
  .option('--admin', 'tail admin audit log instead of the main audit log', false)
  .option('--project <alias>', 'tail one project audit log')
  .action(async (options: { config?: string; limit: string; admin: boolean; project?: string }) => {
    const { config } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
    const auditLog = new AuditLog(resolveAuditLogDir(config, options.project), resolveAuditLogFileName(options));
    const events = await auditLog.tail(Number(options.limit));
    console.log(JSON.stringify(events, null, 2));
  });

auditCommand
  .command('cleanup')
  .description('Archive and prune audit logs using configured or explicit retention settings')
  .option('--config <path>', 'config path override')
  .option('--retention-days <number>', 'drop events older than this many days')
  .option('--archive-after-days <number>', 'archive events older than this many days before retention applies')
  .option('--admin', 'only clean the admin audit log', false)
  .option('--project <alias>', 'only clean one project audit log')
  .action(async (options: { config?: string; retentionDays?: string; archiveAfterDays?: string; admin: boolean; project?: string }) => {
    const { config } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
    const targets = listAuditCleanupTargets(config, options.project, options.admin);
    const retentionDays = Number(options.retentionDays ?? config.service.audit_retention_days);
    const archiveAfterDays = Number(options.archiveAfterDays ?? config.service.audit_archive_after_days);
    const results = await Promise.all(
      targets.map((target) =>
        new AuditLog(target.stateDir, target.fileName).cleanup({
          retentionDays,
          archiveAfterDays,
          archiveDir: target.archiveDir,
        }),
      ),
    );
    console.log(JSON.stringify(results, null, 2));
  });

const serviceCommand = program.command('service').description('Install or inspect an OS user service definition');

serviceCommand
  .command('print')
  .description('Print the launchd/systemd service definition and helper commands')
  .option('--config <path>', 'config path override')
  .option('--service-name <name>', 'service name', 'feishu-bridge')
  .option('--working-dir <dir>', 'working directory', process.cwd())
  .option('--log-dir <dir>', 'log directory')
  .option('--platform <platform>', 'darwin or linux')
  .action(async (options: { config?: string; serviceName: string; workingDir: string; logDir?: string; platform?: NodeJS.Platform }) => {
    const descriptor = buildServiceDescriptor({
      serviceName: options.serviceName,
      cliScriptPath: path.resolve(process.argv[1] ?? 'dist/cli.js'),
      nodeBinaryPath: process.execPath,
      workingDirectory: path.resolve(options.workingDir),
      ...(options.config ? { configPath: path.resolve(options.config) } : {}),
      logDirectory: path.resolve(options.logDir ?? resolveDefaultLogDirectory()),
      ...(options.platform ? { platform: options.platform } : {}),
    });
    console.log(`# Target path
${descriptor.targetPath}
`);
    console.log(`# Install
${descriptor.installHint}
`);
    console.log(`# Start
${descriptor.startHint}
`);
    console.log(`# Stop
${descriptor.stopHint}
`);
    console.log(`# Status
${descriptor.statusHint}
`);
    console.log(`# Uninstall
${descriptor.uninstallHint}
`);
    console.log(descriptor.content);
  });

serviceCommand
  .command('install')
  .description('Write a launchd/systemd user service file for the bridge')
  .option('--config <path>', 'config path override')
  .option('--service-name <name>', 'service name', 'feishu-bridge')
  .option('--working-dir <dir>', 'working directory', process.cwd())
  .option('--log-dir <dir>', 'log directory')
  .option('--platform <platform>', 'darwin or linux')
  .action(async (options: { config?: string; serviceName: string; workingDir: string; logDir?: string; platform?: NodeJS.Platform }) => {
    const descriptor = await installServiceFile({
      serviceName: options.serviceName,
      cliScriptPath: path.resolve(process.argv[1] ?? 'dist/cli.js'),
      nodeBinaryPath: process.execPath,
      workingDirectory: path.resolve(options.workingDir),
      ...(options.config ? { configPath: path.resolve(options.config) } : {}),
      ...(options.logDir ? { logDirectory: path.resolve(options.logDir) } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    });
    console.log(`Wrote ${descriptor.targetPath}`);
    console.log(`Install: ${descriptor.installHint}`);
    console.log(`Start: ${descriptor.startHint}`);
    console.log(`Stop: ${descriptor.stopHint}`);
    console.log(`Status: ${descriptor.statusHint}`);
  });

serviceCommand
  .command('uninstall')
  .description('Remove the generated launchd/systemd user service file')
  .option('--service-name <name>', 'service name', 'feishu-bridge')
  .option('--platform <platform>', 'darwin or linux')
  .action(async (options: { serviceName: string; platform?: NodeJS.Platform }) => {
    const result = await uninstallServiceFile({
      serviceName: options.serviceName,
      ...(options.platform ? { platform: options.platform } : {}),
    });
    console.log(result.removed ? `Removed ${result.targetPath}` : `No service file at ${result.targetPath}`);
  });

program
  .command('print-config')
  .description('Print the merged effective config as JSON')
  .option('--config <path>', 'config path override')
  .action(async (options: { config?: string }) => {
    const { config, sources } = await loadBridgeConfig({ cwd: process.cwd(), configPath: options.config });
    const printable = structuredClone(config) as Record<string, unknown>;
    if (typeof printable.feishu === 'object' && printable.feishu) {
      (printable.feishu as Record<string, unknown>).app_secret = '<redacted>';
      if ((printable.feishu as Record<string, unknown>).encrypt_key) {
        (printable.feishu as Record<string, unknown>).encrypt_key = '<redacted>';
      }
      if ((printable.feishu as Record<string, unknown>).verification_token) {
        (printable.feishu as Record<string, unknown>).verification_token = '<redacted>';
      }
    }
    if (typeof printable.mcp === 'object' && printable.mcp) {
      if ((printable.mcp as Record<string, unknown>).auth_token) {
        (printable.mcp as Record<string, unknown>).auth_token = '<redacted>';
      }
      if (Array.isArray((printable.mcp as Record<string, unknown>).auth_tokens)) {
        (printable.mcp as Record<string, unknown>).auth_tokens = ((printable.mcp as Record<string, unknown>).auth_tokens as Array<Record<string, unknown>>).map((token) => ({
          ...token,
          token: '<redacted>',
        }));
      }
    }
    console.log(JSON.stringify({ sources, config: printable }, null, 2));
  });


async function collectDoctorConfigPaths(cwd: string, explicitConfigPath?: string): Promise<string[]> {
  const paths = new Set<string>();
  if (explicitConfigPath) {
    paths.add(path.resolve(explicitConfigPath));
  } else {
    paths.add(getGlobalConfigPath());
    const projectPath = await findNearestProjectConfig(cwd);
    if (projectPath) {
      paths.add(projectPath);
    }
  }
  return Array.from(paths);
}

function printDoctorFindings(findings: { level: 'info' | 'warn' | 'error'; message: string }[], asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  for (const finding of findings) {
    console.log(formatDoctorFinding(finding));
  }
}

function ensureTrailingSlash(input: string): string {
  return input.endsWith('/') ? input : `${input}/`;
}

function trimLeadingSlash(input: string): string {
  return input.startsWith('/') ? input.slice(1) : input;
}

function getRuntimePaths(config: RuntimeCliConfig): {
  pidPath: string;
  logPath: string;
} {
  return {
    pidPath: path.join(config.storage.dir, `${config.service.name}.pid`),
    logPath: path.join(config.storage.dir, `${config.service.name}.log`),
  };
}

function getManagedLogPaths(config: RuntimeCliConfig): string[] {
  const runtimePaths = getRuntimePaths(config);
  return [
    runtimePaths.logPath,
    path.join(config.storage.dir, 'audit.jsonl'),
    path.join(config.storage.dir, 'admin-audit.jsonl'),
  ];
}

function resolveAuditLogDir(config: BridgeConfig, projectAlias?: string): string {
  if (!projectAlias) {
    return config.storage.dir;
  }
  const project = config.projects[projectAlias];
  if (!project) {
    throw new Error(`Unknown project alias: ${projectAlias}`);
  }
  return getProjectAuditDir(config.storage.dir, projectAlias, project);
}

function resolveAuditLogFileName(options: { admin: boolean; project?: string }): string {
  if (options.project) {
    return 'project-audit.jsonl';
  }
  return options.admin ? 'admin-audit.jsonl' : 'audit.jsonl';
}

function listAuditCleanupTargets(
  config: BridgeConfig,
  projectAlias?: string,
  adminOnly: boolean = false,
): Array<{ stateDir: string; fileName: string; archiveDir: string }> {
  if (projectAlias) {
    const project = config.projects[projectAlias];
    if (!project) {
      throw new Error(`Unknown project alias: ${projectAlias}`);
    }
    return [
      {
        stateDir: getProjectAuditDir(config.storage.dir, projectAlias, project),
        fileName: 'project-audit.jsonl',
        archiveDir: getProjectArchiveDir(config.storage.dir, projectAlias),
      },
    ];
  }

  const targets = [
    {
      stateDir: config.storage.dir,
      fileName: adminOnly ? 'admin-audit.jsonl' : 'audit.jsonl',
      archiveDir: path.join(config.storage.dir, 'archive'),
    },
  ];
  if (!adminOnly) {
    targets.push({
      stateDir: config.storage.dir,
      fileName: 'admin-audit.jsonl',
      archiveDir: path.join(config.storage.dir, 'archive'),
    });
    for (const [alias, project] of Object.entries(config.projects)) {
      targets.push({
        stateDir: getProjectAuditDir(config.storage.dir, alias, project),
        fileName: 'project-audit.jsonl',
        archiveDir: getProjectArchiveDir(config.storage.dir, alias),
      });
    }
  }
  return targets;
}

async function inspectRuntimeStatus(config: RuntimeCliConfig): Promise<{
  running: boolean;
  pid?: number;
  pidPath: string;
  logPath: string;
  activeRuns: number;
}> {
  const runtimePaths = getRuntimePaths(config);
  const pid = await readPid(runtimePaths.pidPath);
  const runStateStore = new RunStateStore(config.storage.dir);
  const activeRuns = (await runStateStore.listActiveRuns()).length;

  return {
    running: pid !== null && isProcessAlive(pid),
    ...(pid !== null ? { pid } : {}),
    pidPath: runtimePaths.pidPath,
    logPath: runtimePaths.logPath,
    activeRuns,
  };
}

async function readPid(filePath: string): Promise<number | null> {
  try {
    const raw = (await fs.readFile(filePath, 'utf8')).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function stopRuntimeProcess(pid: number, waitMs: number, force: boolean): Promise<boolean> {
  if (!terminateProcess(pid, 'SIGTERM')) {
    return !isProcessAlive(pid);
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }

  if (!force) {
    return !isProcessAlive(pid);
  }

  terminateProcess(pid, 'SIGKILL');
  const forceDeadline = Date.now() + 2000;
  while (Date.now() < forceDeadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const sliced = content.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
    return sliced ? `${sliced}\n` : '';
  } catch {
    return '';
  }
}

async function rotateManagedLogs(
  config: RuntimeCliConfig,
  options: {
    force?: boolean;
  } = {},
): Promise<string[]> {
  await fs.mkdir(config.storage.dir, { recursive: true });
  const rotated: string[] = [];
  for (const filePath of getManagedLogPaths(config)) {
    const rotatedFile = await rotateFileIfNeeded(filePath, config.service.log_rotate_max_bytes, config.service.log_rotate_keep_files, options.force === true);
    if (rotatedFile) {
      rotated.push(rotatedFile);
    }
  }
  return rotated;
}

async function rotateFileIfNeeded(filePath: string, maxBytes: number, keepFiles: number, force: boolean): Promise<string | null> {
  const size = await getFileSize(filePath);
  if (size === 0 || (!force && size < maxBytes)) {
    return null;
  }
  for (let index = keepFiles; index >= 1; index -= 1) {
    const current = `${filePath}.${index}`;
    const next = `${filePath}.${index + 1}`;
    if (index === keepFiles && (await fileExists(current))) {
      await fs.rm(current, { force: true });
      continue;
    }
    if (await fileExists(current)) {
      await fs.rename(current, next);
    }
  }
  await fs.rename(filePath, `${filePath}.1`);
  return `${filePath}.1`;
}

async function followFile(filePath: string, lines: number): Promise<void> {
  const initial = await tailFile(filePath, lines);
  if (initial) {
    process.stdout.write(initial);
  } else {
    process.stdout.write('Waiting for runtime log output...\n');
  }

  let offset = await getFileSize(filePath);

  await new Promise<void>((resolve, reject) => {
    let closed = false;
    let polling = false;

    const stop = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };

    const timer = setInterval(() => {
      if (polling || closed) {
        return;
      }
      polling = true;
      void readAppendedContent()
        .then(() => {
          polling = false;
        })
        .catch((error) => {
          clearInterval(timer);
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
          reject(error);
        });
    }, 500);

    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

  async function readAppendedContent(): Promise<void> {
    const size = await getFileSize(filePath);
    if (size < offset) {
      offset = 0;
    }
    if (size === offset) {
      return;
    }
    try {
      const handle = await fs.open(filePath, 'r');
      try {
        const length = size - offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        offset = size;
        process.stdout.write(buffer.toString('utf8'));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function detachServeProcess(input: {
  config: BridgeConfig;
  configPath?: string;
  cwd: string;
}): Promise<{
  pid: number;
  logPath: string;
  pidPath: string;
}> {
  await fs.mkdir(input.config.storage.dir, { recursive: true });
  await rotateManagedLogs(input.config);
  const logPath = path.join(input.config.storage.dir, `${input.config.service.name}.log`);
  const pidPath = path.join(input.config.storage.dir, `${input.config.service.name}.pid`);
  const stdoutFd = openSync(logPath, 'a');
  const stderrFd = openSync(logPath, 'a');

  try {
    const cliEntry = process.argv[1];
    if (!cliEntry) {
      throw new Error('Unable to determine CLI entry path for detached serve.');
    }

    const args = [...process.execArgv, cliEntry, 'serve', '--skip-doctor'];
    if (input.configPath) {
      args.push('--config', path.resolve(input.configPath));
    }

    const child = spawn(process.execPath, args, {
      cwd: input.cwd,
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      env: {
        ...process.env,
      },
    });
    child.unref();
    await fs.writeFile(pidPath, `${child.pid}\n`, 'utf8');
    return {
      pid: child.pid ?? 0,
      logPath,
      pidPath,
    };
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

async function applySafeDoctorFixes(config: BridgeConfig): Promise<string[]> {
  const fixes: string[] = [];
  await fs.mkdir(config.storage.dir, { recursive: true });
  fixes.push(`ensured storage dir: ${config.storage.dir}`);

  const runtimeStatus = await inspectRuntimeStatus(config);
  if (!runtimeStatus.running && (await fileExists(runtimeStatus.pidPath))) {
    await fs.rm(runtimeStatus.pidPath, { force: true });
    fixes.push(`removed stale pid file: ${runtimeStatus.pidPath}`);
  }

  const rotated = await rotateManagedLogs(config);
  fixes.push(...rotated.map((file) => `rotated log: ${file}`));
  const cleanedAudits = await Promise.all(
    listAuditCleanupTargets(config).map((target) =>
      new AuditLog(target.stateDir, target.fileName).cleanup({
        retentionDays: config.service.audit_retention_days,
        archiveAfterDays: config.service.audit_archive_after_days,
        archiveDir: target.archiveDir,
      }),
    ),
  );
  for (const result of cleanedAudits) {
    if (result.archived > 0 || result.removed > 0) {
      fixes.push(`cleaned audit: ${result.filePath} (archived=${result.archived}, removed=${result.removed})`);
    }
  }
  return fixes;
}

async function fetchLatestPublishedVersion(): Promise<string> {
  const stdout = await runChildForStdout('npm', ['view', 'feishu-bridge', 'version']);
  return stdout.trim();
}

async function installLatestPublishedVersion(): Promise<void> {
  await runChildForStdout('npm', ['install', '-g', 'feishu-bridge@latest']);
}

async function runChildForStdout(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
    });
  });
}

program.parseAsync(process.argv).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ err: error }, 'Command failed');
  process.stderr.write(`${message}\n`);
  try {
    await fs.rm(path.join(process.cwd(), '.tmp'), { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exitCode = 1;
});
