import type {
  AllowedAccount,
  ApiError,
  BackupRetention,
  BackupRun,
  CreateMember,
  Me,
  MemberDetail,
  MemberList,
  MemberListQuery,
  MemberStatusAction,
  UpdateMember,
  AddAlias,
  ImportBatchListItem,
  ImportBatchView,
  ImportBulk,
  ImportMapping,
  ImportRowFilter,
  ImportRowPatch,
  ImportRowsPage,
  ImportRowView,
  MappingPreset,
  PublicConfig,
  SystemStatus,
  UpdateWorkspaceSettings,
  WorkspaceSettings,
} from '@subscriberr/shared';

/** Error thrown for any non-2xx API response; carries the server's { error: { code, message } }. */
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  // CSRF: the server requires this header on every state-changing request.
  headers.set('X-Requested-With', 'subscriberr');
  // FormData sets its own multipart Content-Type (with the boundary).
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as Partial<ApiError> | null)?.error;
    throw new ApiRequestError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status})`, err?.details ?? body);
  }
  return body as T;
}

const send = <T>(method: string, path: string, body: unknown = {}) => request<T>(path, { method, body: JSON.stringify(body) });

/**
 * Full-page navigation that starts Google sign-in. `return_to` brings the browser back to this
 * origin afterwards (in development that is the Vite server on another port).
 */
export function googleStartUrl(options: { switchAccount?: boolean } = {}): string {
  const params = new URLSearchParams({ return_to: `${window.location.origin}/` });
  if (options.switchAccount) params.set('switch', '1');
  return `/auth/google/start?${params.toString()}`;
}

export const api = {
  publicConfig: () => request<PublicConfig>('/api/public-config'),
  me: () => request<Me>('/api/me'),
  devLogin: () => send<Me>('POST', '/auth/dev-login'),
  logout: () => send<{ ok: true }>('POST', '/auth/logout'),

  workspaceSettings: () => request<WorkspaceSettings>('/api/workspace/settings'),
  updateWorkspaceSettings: (patch: UpdateWorkspaceSettings) => send<WorkspaceSettings>('PATCH', '/api/workspace/settings', patch),
  completeOnboarding: () => send<WorkspaceSettings>('POST', '/api/workspace/onboarding/complete'),
  disconnectGoogle: () => send<{ revoked: boolean }>('POST', '/api/workspace/google/disconnect'),

  allowlist: () => request<{ items: AllowedAccount[] }>('/api/allowlist'),
  addAllowed: (email: string) => send<{ items: AllowedAccount[] }>('POST', '/api/allowlist', { email }),
  removeAllowed: (email: string) => send<{ items: AllowedAccount[]; sessionsEnded: number }>('DELETE', `/api/allowlist/${encodeURIComponent(email)}`),

  members: (query: MemberListQuery) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, String(v));
    return request<MemberList>(`/api/members?${params.toString()}`);
  },
  member: (id: number) => request<MemberDetail>(`/api/members/${id}`),
  createMember: (body: CreateMember) => send<MemberDetail>('POST', '/api/members', body),
  updateMember: (id: number, patch: UpdateMember) => send<MemberDetail>('PATCH', `/api/members/${id}`, patch),
  memberStatus: (id: number, action: MemberStatusAction) => send<MemberDetail>('POST', `/api/members/${id}/status`, { action }),
  deleteMember: (id: number) => send<{ ok: true }>('DELETE', `/api/members/${id}`),
  addAlias: (id: number, alias: AddAlias) => send<MemberDetail>('POST', `/api/members/${id}/aliases`, alias),
  removeAlias: (id: number, aliasId: number) => send<MemberDetail>('DELETE', `/api/members/${id}/aliases/${aliasId}`),

  csvExportUrl: (query: Pick<MemberListQuery, 'q' | 'status' | 'sort' | 'dir'> = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, String(v));
    return `/api/csv/export?${params.toString()}`;
  },
  csvTemplateUrl: '/api/csv/template',
  imports: () => request<{ items: ImportBatchListItem[] }>('/api/csv/imports'),
  uploadImport: (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<ImportBatchView>('/api/csv/imports', { method: 'POST', body });
  },
  importBatch: (id: number) => request<ImportBatchView>(`/api/csv/imports/${id}`),
  setImportMapping: (id: number, mapping: ImportMapping) => send<ImportBatchView>('PUT', `/api/csv/imports/${id}/mapping`, mapping),
  importRows: (id: number, q: { filter: ImportRowFilter; page: number; pageSize: number }) =>
    request<ImportRowsPage>(`/api/csv/imports/${id}/rows?filter=${q.filter}&page=${q.page}&pageSize=${q.pageSize}`),
  patchImportRow: (id: number, rowId: number, patch: ImportRowPatch) =>
    send<{ row: ImportRowView; summary: ImportRowsPage['summary'] }>('PATCH', `/api/csv/imports/${id}/rows/${rowId}`, patch),
  bulkImport: (id: number, bulk: ImportBulk) => send<{ summary: ImportRowsPage['summary'] }>('POST', `/api/csv/imports/${id}/bulk`, bulk),
  commitImport: (id: number) => send<ImportBatchView>('POST', `/api/csv/imports/${id}/commit`),
  undoImport: (id: number) => send<ImportBatchView>('POST', `/api/csv/imports/${id}/undo`),
  abandonImport: (id: number) => send<{ ok: true }>('DELETE', `/api/csv/imports/${id}`),
  mappingPresets: () => request<{ items: MappingPreset[] }>('/api/csv/presets'),
  saveMappingPresets: (items: MappingPreset[]) => send<{ items: MappingPreset[] }>('PUT', '/api/csv/presets', { items }),

  systemStatus: () => request<SystemStatus>('/api/system/status'),
  backups: () => request<{ items: BackupRun[] }>('/api/system/backups'),
  backupNow: () => send<{ run: BackupRun }>('POST', '/api/system/backups'),
  backupRetention: () => request<BackupRetention>('/api/system/backup-retention'),
  setBackupRetention: (value: BackupRetention) => send<BackupRetention>('PUT', '/api/system/backup-retention', value),
};
