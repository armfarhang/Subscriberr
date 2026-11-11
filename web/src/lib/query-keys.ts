/** Central TanStack Query keys, so invalidation never relies on string typos. */
export const queryKeys = {
  publicConfig: ['public-config'] as const,
  me: ['me'] as const,
  systemStatus: ['system', 'status'] as const,
  backups: ['system', 'backups'] as const,
};
