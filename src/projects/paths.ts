import path from 'node:path';
import type { ProjectConfig } from '../config/schema.js';

export function getProjectStateDir(storageDir: string, projectAlias: string): string {
  return path.join(storageDir, 'projects', sanitizeProjectAlias(projectAlias));
}

export function getProjectDownloadsDir(storageDir: string, projectAlias: string, project: ProjectConfig): string {
  return project.download_dir ? path.resolve(project.download_dir) : path.join(getProjectStateDir(storageDir, projectAlias), 'downloads');
}

export function getProjectTempDir(storageDir: string, projectAlias: string, project: ProjectConfig): string {
  return project.temp_dir ? path.resolve(project.temp_dir) : path.join(getProjectStateDir(storageDir, projectAlias), 'tmp');
}

export function getProjectCacheDir(storageDir: string, projectAlias: string, project: ProjectConfig): string {
  return project.cache_dir ? path.resolve(project.cache_dir) : path.join(getProjectStateDir(storageDir, projectAlias), 'cache');
}

export function getProjectLogDir(storageDir: string, projectAlias: string, project: ProjectConfig): string {
  return project.log_dir ? path.resolve(project.log_dir) : path.join(getProjectStateDir(storageDir, projectAlias), 'logs');
}

export function getProjectAuditDir(storageDir: string, projectAlias: string, project: ProjectConfig): string {
  return getProjectLogDir(storageDir, projectAlias, project);
}

function sanitizeProjectAlias(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return normalized.length > 0 ? normalized : 'default';
}
