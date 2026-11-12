import type {
  AllowedAccount,
  ApiError,
  BackupRetention,
  BackupRun,
  Me,
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
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

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

  systemStatus: () => request<SystemStatus>('/api/system/status'),
  backups: () => request<{ items: BackupRun[] }>('/api/system/backups'),
  backupNow: () => send<{ run: BackupRun }>('POST', '/api/system/backups'),
  backupRetention: () => request<BackupRetention>('/api/system/backup-retention'),
  setBackupRetention: (value: BackupRetention) => send<BackupRetention>('PUT', '/api/system/backup-retention', value),
};
