import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Directory that holds one workspace's files: /data/workspaces/{account_id}/ (Spec §5.5).
 * Only ever built from the numeric account id, so it can never point at another workspace.
 */
export function workspaceDir(workspacesRoot: string, accountId: number): string {
  if (!Number.isInteger(accountId) || accountId <= 0) throw new Error('Invalid account id');
  return path.join(path.resolve(workspacesRoot), String(accountId));
}

/**
 * Resolves a path inside a workspace directory and refuses anything that escapes it
 * (absolute paths, `..`, another workspace's folder).
 */
export function resolveInWorkspace(workspacesRoot: string, accountId: number, relative: string): string {
  const root = workspaceDir(workspacesRoot, accountId);
  if (path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Path must be relative to the workspace');
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Path escapes the workspace directory');
  return target;
}

export function ensureWorkspaceDir(workspacesRoot: string, accountId: number): string {
  const dir = workspaceDir(workspacesRoot, accountId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
