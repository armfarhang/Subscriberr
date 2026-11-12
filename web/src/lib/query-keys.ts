/** Central TanStack Query keys, so invalidation never relies on string typos. */
export const queryKeys = {
  publicConfig: ['public-config'] as const,
  me: ['me'] as const,
  workspaceSettings: ['workspace', 'settings'] as const,
  allowlist: ['allowlist'] as const,
  systemStatus: ['system', 'status'] as const,
  backups: ['system', 'backups'] as const,
  backupRetention: ['system', 'backup-retention'] as const,
};
