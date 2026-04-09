import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import type { Backend, BackendName } from './types.js';
import { CodexSessionIndex } from '../codex/session-index.js';
import { probeBackend, type ProbeResult } from './probe.js';
import {
  getBackendDefinition,
  requireBackendDefinition,
  listBackendNames,
  type BackendDependencies,
} from './registry.js';

// Side-effect imports: these force the codex and claude backend modules
// to load and call registerBackend() before the factory is first used.
// Adding a new backend means adding a matching import line here (and in
// src/bridge/service.ts for anything that uses BackendName before the
// factory is touched — rare).
import './codex.js';
import './claude.js';

function toDeps(codexSessionIndex?: CodexSessionIndex): BackendDependencies {
  return codexSessionIndex ? { codexSessionIndex } : {};
}

export function createBackend(config: BridgeConfig, codexSessionIndex?: CodexSessionIndex): Backend {
  const backendName = resolveDefaultBackend(config);
  return createBackendByName(backendName, config, codexSessionIndex);
}

export function createBackendByName(name: BackendName, config: BridgeConfig, codexSessionIndex?: CodexSessionIndex): Backend {
  const def = requireBackendDefinition(name);
  return def.create(config, toDeps(codexSessionIndex));
}

export function resolveDefaultBackend(config: BridgeConfig): BackendName {
  return config.backend?.default ?? 'codex';
}

export function resolveProjectBackend(config: BridgeConfig, projectAlias: string, codexSessionIndex?: CodexSessionIndex): Backend {
  const project = config.projects[projectAlias];
  const backendName: BackendName = project?.backend ?? resolveDefaultBackend(config);
  return createBackendByName(backendName, config, codexSessionIndex);
}

export function resolveProjectBackendWithOverride(
  config: BridgeConfig,
  projectAlias: string,
  sessionOverride?: BackendName,
  codexSessionIndex?: CodexSessionIndex,
): Backend {
  if (sessionOverride) {
    return createBackendByName(sessionOverride, config, codexSessionIndex);
  }
  return resolveProjectBackend(config, projectAlias, codexSessionIndex);
}

export function resolveProjectBackendName(config: BridgeConfig, projectAlias: string, sessionOverride?: BackendName): BackendName {
  if (sessionOverride) return sessionOverride;
  const project = config.projects[projectAlias];
  return project?.backend ?? resolveDefaultBackend(config);
}

// ---------------------------------------------------------------------------
// Startup-only failover with configurable fallback chain
// ---------------------------------------------------------------------------

export interface FailoverInfo {
  from: BackendName;
  to: BackendName;
  reason: string;
}

export interface FailoverResolution {
  backend: Backend;
  name: BackendName;
  failover?: FailoverInfo;
}

function isFailoverEnabled(config: BridgeConfig, projectAlias: string): boolean {
  const project = config.projects[projectAlias];
  if (project?.failover !== undefined) return project.failover;
  return config.backend?.failover ?? true;
}

/**
 * Resolve the fallback chain for a given primary backend:
 *   1. project.fallback (per-project override)
 *   2. config.backend.fallback (global)
 *   3. registry definition's defaultFallback (e.g. codex → ['claude'])
 *   4. "all other registered backends in registration order"
 *
 * The returned list never contains the primary, is de-duplicated, and
 * skips any names that are not registered.
 */
export function resolveFallbackChain(
  config: BridgeConfig,
  projectAlias: string,
  primary: BackendName,
): BackendName[] {
  const project = config.projects[projectAlias];
  let raw: readonly string[] | undefined =
    project?.fallback ??
    config.backend?.fallback ??
    getBackendDefinition(primary)?.defaultFallback;

  if (!raw) {
    raw = listBackendNames();
  }

  const seen = new Set<string>();
  const chain: BackendName[] = [];
  for (const candidate of raw) {
    if (candidate === primary) continue;
    if (seen.has(candidate)) continue;
    if (!getBackendDefinition(candidate)) continue; // skip unknown
    seen.add(candidate);
    chain.push(candidate);
  }
  return chain;
}

/**
 * Resolve the backend to use for a run, with startup-only failover.
 *
 * Strategy:
 *  1. Determine primary backend name (session override > project > default).
 *  2. If failover is disabled, return the primary without probing.
 *  3. Probe the primary. If it responds, return it.
 *  4. Walk the fallback chain (see resolveFallbackChain) probing each
 *     candidate in order; first successful probe wins and the caller
 *     gets a FailoverInfo describing the switch.
 *  5. If every candidate fails, return the primary so the real error
 *     surfaces on the actual run rather than being masked by a silent
 *     rewrite.
 *
 * Runtime failures during an actual run are NOT retried here. That is
 * the deliberate boundary: we save users from "binary missing" and
 * PATH issues, but we never burn tokens on speculative re-runs.
 */
export async function resolveProjectBackendWithFailover(
  config: BridgeConfig,
  projectAlias: string,
  sessionOverride?: BackendName,
  codexSessionIndex?: CodexSessionIndex,
): Promise<FailoverResolution> {
  const primaryName = resolveProjectBackendName(config, projectAlias, sessionOverride);

  if (!isFailoverEnabled(config, projectAlias)) {
    return {
      backend: createBackendByName(primaryName, config, codexSessionIndex),
      name: primaryName,
    };
  }

  const primaryDef = requireBackendDefinition(primaryName);
  const primaryProbe: ProbeResult = await probeBackend(primaryName, primaryDef.probeSpec(config));
  if (primaryProbe.ok) {
    return {
      backend: primaryDef.create(config, toDeps(codexSessionIndex)),
      name: primaryName,
    };
  }

  const chain = resolveFallbackChain(config, projectAlias, primaryName);
  for (const candidate of chain) {
    const def = requireBackendDefinition(candidate);
    const probe = await probeBackend(candidate, def.probeSpec(config));
    if (probe.ok) {
      return {
        backend: def.create(config, toDeps(codexSessionIndex)),
        name: candidate,
        failover: {
          from: primaryName,
          to: candidate,
          reason: primaryProbe.reason ?? 'unknown',
        },
      };
    }
  }

  // All probes failed — let the primary run and report the real error.
  return {
    backend: primaryDef.create(config, toDeps(codexSessionIndex)),
    name: primaryName,
  };
}
