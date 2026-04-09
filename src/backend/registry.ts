import type { BridgeConfig } from '../config/schema.js';
import type { Backend, BackendName } from './types.js';
import type { ProbeSpec } from './probe.js';
import type { CodexSessionIndex } from '../codex/session-index.js';

/**
 * Extensible backend registry.
 *
 * Every backend (codex, claude, qwen, ...) contributes a BackendDefinition
 * that knows how to construct itself from BridgeConfig and how to expose
 * its probe spec for startup failover. Adding a new backend is purely an
 * additive change: drop a new file under src/backend/, export its
 * definition, call registerBackend() at module load, and wire it into
 * src/backend/factory.ts's side-effect import list.
 *
 * BackendName is intentionally widened to `string` (see types.ts) —
 * compile-time literal unions were incompatible with a registry because
 * every new backend would require touching the type. Runtime validation
 * happens in requireBackendDefinition().
 */

export interface BackendDependencies {
  /**
   * Shared CodexSessionIndex, passed in by FeiqueService. Any backend
   * that wants access can read it from here; codex relies on it for
   * resume semantics.
   */
  codexSessionIndex?: CodexSessionIndex;
}

export interface BackendDefinition {
  /** Unique registry key, e.g. 'codex', 'claude', 'qwen'. */
  readonly name: string;

  /**
   * Build a live Backend instance from config. Called on every run so
   * hot-reloaded config is picked up immediately.
   */
  create(config: BridgeConfig, deps: BackendDependencies): Backend;

  /**
   * Extract the probe spec (bin + shell + pre_exec) from config.
   * Used by the failover resolver before each run.
   */
  probeSpec(config: BridgeConfig): ProbeSpec;

  /**
   * Optional default fallback chain. Used when neither the project nor
   * the global config supplies an explicit fallback list. If omitted,
   * the resolver falls back to "every other registered backend" in
   * registration order.
   *
   * Example: codex's default fallback is ['claude'] so that when codex
   * is broken on a box, users get claude automatically without needing
   * to set anything.
   */
  readonly defaultFallback?: readonly string[];
}

const registry = new Map<string, BackendDefinition>();

export function registerBackend(definition: BackendDefinition): void {
  registry.set(definition.name, definition);
}

export function getBackendDefinition(name: string): BackendDefinition | undefined {
  return registry.get(name);
}

export function requireBackendDefinition(name: string): BackendDefinition {
  const def = registry.get(name);
  if (!def) {
    const known = [...registry.keys()].join(', ') || '(none)';
    throw new Error(`Unknown backend: ${name}. Registered backends: ${known}`);
  }
  return def;
}

export function listBackendNames(): BackendName[] {
  return [...registry.keys()];
}

/** Visible for tests only. */
export function clearBackendRegistry(): void {
  registry.clear();
}
