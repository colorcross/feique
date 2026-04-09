import { spawn } from 'node:child_process';
import type { BackendName } from './types.js';

/**
 * Lightweight pre-run probe for a backend CLI.
 *
 * Used by the failover resolver to decide whether the primary backend is
 * actually callable on this machine. Runs `<bin> --version` with a short
 * timeout, respecting the same shell / pre_exec chain the real backend would
 * use, so a broken `proxy_on` hook surfaces here rather than inside a real
 * turn.
 *
 * Results are cached for 60 seconds keyed by (backend, bin, shell, preExec) —
 * enough to absorb the common "several runs in quick succession" case without
 * masking real fixes for longer than a minute.
 */

export interface ProbeResult {
  ok: boolean;
  /** Human-readable reason when ok=false. */
  reason?: string;
}

interface CacheEntry {
  expiresAt: number;
  result: ProbeResult;
}

const PROBE_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(backend: BackendName, bin: string, shell: string | undefined, preExec: string | undefined): string {
  return `${backend}\0${bin}\0${shell ?? ''}\0${preExec ?? ''}`;
}

/** Visible for tests. */
export function clearProbeCache(): void {
  cache.clear();
}

export interface ProbeSpec {
  bin: string;
  shell?: string | undefined;
  preExec?: string | undefined;
}

function buildProbeCommand(spec: ProbeSpec): { command: string; args: string[] } {
  if (!spec.preExec) {
    return { command: spec.bin, args: ['--version'] };
  }
  const shell = spec.shell ?? process.env.SHELL ?? '/bin/zsh';
  // Single-quote bin because preExec is already a shell command line.
  const chained = `${spec.preExec} && ${JSON.stringify(spec.bin)} --version`;
  return { command: shell, args: ['-ic', chained] };
}

async function runProbe(spec: ProbeSpec): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const { command, args } = buildProbeCommand(spec);
    let settled = false;
    let stderr = '';

    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, reason: `timeout after ${PROBE_TIMEOUT_MS}ms running ${spec.bin} --version` });
    }, PROBE_TIMEOUT_MS);
    timer.unref();

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2000) stderr = stderr.slice(0, 2000);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        resolve({ ok: false, reason: `binary not found: ${spec.bin}` });
        return;
      }
      resolve({ ok: false, reason: `spawn error (${code ?? 'unknown'}): ${error.message}` });
    });

    child.on('exit', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitCode === 0) {
        resolve({ ok: true });
        return;
      }
      const tail = stderr.trim().split('\n').slice(-1)[0] ?? '';
      resolve({
        ok: false,
        reason: `${spec.bin} --version exited with code ${exitCode}${tail ? `: ${tail}` : ''}`,
      });
    });
  });
}

export async function probeBackend(backend: BackendName, spec: ProbeSpec): Promise<ProbeResult> {
  const key = cacheKey(backend, spec.bin, spec.shell, spec.preExec);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }
  const result = await runProbe(spec);
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
  return result;
}
