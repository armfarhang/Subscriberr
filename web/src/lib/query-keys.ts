/** Central TanStack Query keys, so invalidation never relies on string typos. */
export const queryKeys = {
  publicConfig: ['public-config'] as const,
  me: ['me'] as const,
  workspaceSettings: ['workspace', 'settings'] as const,
  allowlist: ['allowlist'] as const,
  members: ['members'] as const,
  memberList: (query: object) => ['members', 'list', query] as const,
  member: (id: number) => ['members', 'detail', id] as const,
  imports: ['imports'] as const,
  importBatch: (id: number) => ['imports', id] as const,
  importRows: (id: number, q: object) => ['imports', id, 'rows', q] as const,
  mappingPresets: ['imports', 'presets'] as const,
  systemStatus: ['system', 'status'] as const,
  backups: ['system', 'backups'] as const,
  backupRetention: ['system', 'backup-retention'] as const,
};
