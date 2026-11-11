import type { ApiError, BackupRun, Me, PublicConfig, SystemStatus } from '@subscriberr/shared';

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
    // A failed "back up now" still returns the recorded run; surface it to the caller.
    throw new ApiRequestError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status})`, err?.details ?? body);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  publicConfig: () => request<PublicConfig>('/api/public-config'),
  me: () => request<Me>('/api/me'),
  devLogin: () => post<Me>('/auth/dev-login'),
  logout: () => post<{ ok: true }>('/auth/logout'),
  systemStatus: () => request<SystemStatus>('/api/system/status'),
  backups: () => request<{ items: BackupRun[] }>('/api/system/backups'),
  backupNow: () => post<{ run: BackupRun }>('/api/system/backups'),
};
