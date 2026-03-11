import type { BridgeConfig } from '../config/schema.js';

export type AccessRole = 'viewer' | 'operator' | 'admin';
export type ProjectCapability = 'project:view' | 'project:switch' | 'session:list' | 'session:control' | 'run:execute' | 'run:cancel' | 'project:mutate';
export type GlobalCapability = 'service:status' | 'service:runs' | 'service:restart' | 'config:history' | 'config:rollback' | 'config:mutate';

const ROLE_ORDER: AccessRole[] = ['viewer', 'operator', 'admin'];

export function resolveProjectAccessRole(config: BridgeConfig, projectAlias: string, chatId: string): AccessRole | null {
  return maxRole([
    resolveGlobalRole(config, chatId),
    resolveScopedRole(config.projects[projectAlias]?.viewer_chat_ids, config.projects[projectAlias]?.operator_chat_ids, config.projects[projectAlias]?.admin_chat_ids, chatId),
  ]);
}

export function canAccessProject(config: BridgeConfig, projectAlias: string, chatId: string, minimumRole: AccessRole = 'viewer'): boolean {
  if (!hasAccessGuard(config, projectAlias)) {
    return true;
  }
  const actual = resolveProjectAccessRole(config, projectAlias, chatId);
  return actual !== null && roleRank(actual) >= roleRank(minimumRole);
}

export function filterAccessibleProjects(config: BridgeConfig, chatId: string, minimumRole: AccessRole = 'viewer'): string[] {
  return Object.keys(config.projects).filter((alias) => canAccessProject(config, alias, chatId, minimumRole));
}

export function canAccessProjectCapability(
  config: BridgeConfig,
  projectAlias: string,
  chatId: string,
  capability: ProjectCapability,
): boolean {
  const project = config.projects[projectAlias];
  if (!project) {
    return false;
  }

  const overrideList = resolveProjectCapabilityList(config, projectAlias, capability);
  if (hasEntries(overrideList)) {
    const scopedList = overrideList!;
    if (scopedList.includes(chatId)) {
      return true;
    }
    if (capability === 'project:mutate') {
      return canAccessProject(config, projectAlias, chatId, 'admin');
    }
    return false;
  }

  switch (capability) {
    case 'project:view':
    case 'project:switch':
    case 'session:list':
      return canAccessProject(config, projectAlias, chatId, 'viewer');
    case 'session:control':
    case 'run:execute':
    case 'run:cancel':
      return canAccessProject(config, projectAlias, chatId, 'operator');
    case 'project:mutate':
      return canAccessProject(config, projectAlias, chatId, 'admin');
  }
}

export function canAccessGlobalCapability(config: BridgeConfig, chatId: string, capability: GlobalCapability): boolean {
  const overrideList = resolveGlobalCapabilityList(config, capability);
  if (hasEntries(overrideList)) {
    const scopedList = overrideList!;
    if (scopedList.includes(chatId)) {
      return true;
    }
    if (capability === 'service:restart' || capability === 'config:history' || capability === 'config:rollback' || capability === 'config:mutate') {
      const globalRole = resolveGlobalRole(config, chatId);
      return globalRole !== null && roleRank(globalRole) >= roleRank('admin');
    }
    return false;
  }

  const globalRole = resolveGlobalRole(config, chatId);
  switch (capability) {
    case 'service:status':
    case 'service:runs':
      return globalRole !== null && roleRank(globalRole) >= roleRank('operator');
    case 'service:restart':
    case 'config:history':
    case 'config:rollback':
    case 'config:mutate':
      return globalRole !== null && roleRank(globalRole) >= roleRank('admin');
  }
}

export function describeMinimumRole(role: AccessRole): string {
  switch (role) {
    case 'viewer':
      return 'viewer';
    case 'operator':
      return 'operator';
    case 'admin':
      return 'admin';
  }
}

export function hasAccessGuard(config: BridgeConfig, projectAlias: string): boolean {
  return (
    hasEntries(config.security.viewer_chat_ids) ||
    hasEntries(config.security.operator_chat_ids) ||
    hasEntries(config.security.admin_chat_ids) ||
    hasEntries(config.projects[projectAlias]?.viewer_chat_ids) ||
    hasEntries(config.projects[projectAlias]?.operator_chat_ids) ||
    hasEntries(config.projects[projectAlias]?.admin_chat_ids)
  );
}

export function hasProjectCapabilityOverride(config: BridgeConfig, projectAlias: string, capability: ProjectCapability): boolean {
  const list = resolveProjectCapabilityList(config, projectAlias, capability);
  return Array.isArray(list) && list.length > 0;
}

export function hasGlobalCapabilityOverride(config: BridgeConfig, capability: GlobalCapability): boolean {
  const list = resolveGlobalCapabilityList(config, capability);
  return Array.isArray(list) && list.length > 0;
}

function resolveGlobalRole(config: BridgeConfig, chatId: string): AccessRole | null {
  return resolveScopedRole(config.security.viewer_chat_ids, config.security.operator_chat_ids, config.security.admin_chat_ids, chatId);
}

function resolveProjectCapabilityList(
  config: BridgeConfig,
  projectAlias: string,
  capability: ProjectCapability,
): string[] | undefined {
  const project = config.projects[projectAlias];
  if (!project) {
    return undefined;
  }
  switch (capability) {
    case 'session:control':
      return project.session_operator_chat_ids;
    case 'run:execute':
    case 'run:cancel':
      return project.run_operator_chat_ids;
    case 'project:mutate':
      return project.config_admin_chat_ids;
    default:
      return undefined;
  }
}

function resolveGlobalCapabilityList(config: BridgeConfig, capability: GlobalCapability): string[] | undefined {
  switch (capability) {
    case 'service:status':
    case 'service:runs':
      return config.security.service_observer_chat_ids;
    case 'service:restart':
      return config.security.service_restart_chat_ids;
    case 'config:history':
    case 'config:rollback':
    case 'config:mutate':
      return config.security.config_admin_chat_ids;
  }
}

function resolveScopedRole(
  viewerChatIds: string[] | undefined,
  operatorChatIds: string[] | undefined,
  adminChatIds: string[] | undefined,
  chatId: string,
): AccessRole | null {
  if (adminChatIds?.includes(chatId)) {
    return 'admin';
  }
  if (operatorChatIds?.includes(chatId)) {
    return 'operator';
  }
  if (viewerChatIds?.includes(chatId)) {
    return 'viewer';
  }
  return null;
}

function maxRole(roles: Array<AccessRole | null>): AccessRole | null {
  return roles.reduce<AccessRole | null>((best, current) => {
    if (!current) {
      return best;
    }
    if (!best) {
      return current;
    }
    return roleRank(current) > roleRank(best) ? current : best;
  }, null);
}

function roleRank(role: AccessRole): number {
  return ROLE_ORDER.indexOf(role);
}

function hasEntries(value: string[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}
