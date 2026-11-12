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
  MatchingRuleView,
  AnnouncementDraft,
  AnnouncementRecipient,
  AnnouncementRecipientStatus,
  AnnouncementView,
  Audience,
  EmailPreview,
  EmailQueueItem,
  EmailQueueStatus,
  EmailSettings,
  PackDetail,
  PackProblem,
  PackSummary,
  PreviewRequest,
  TemplateKind,
  BalanceAdjust,
  BalanceSet,
  LedgerEntryView,
  ManualPayment,
  MarkDeposited,
  PaymentList,
  PaymentListQuery,
  PaymentView,
  Rescan,
  RescanResult,
  ResolvePayment,
  RuleFields,
  RuleTest,
  RuleTestResult,
  ScanState,
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
  payments: (query: PaymentListQuery) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, String(v));
    return request<PaymentList>(`/api/payments?${params.toString()}`);
  },
  payment: (id: number) => request<PaymentView>(`/api/payments/${id}`),
  resolvePayment: (id: number, body: ResolvePayment) => send<PaymentView>('POST', `/api/payments/${id}/resolve`, body),
  scanState: () => request<ScanState>('/api/payments/scan'),
  scanNow: () => send<RescanResult>('POST', '/api/payments/scan'),
  rescan: (body: Rescan) => send<RescanResult>('POST', '/api/payments/rescan', body),
  rerunReview: () => send<{ checked: number; matched: number }>('POST', '/api/payments/review/rerun'),
  rules: (memberId?: number) => request<{ items: MatchingRuleView[] }>(`/api/payments/rules${memberId ? `?memberId=${memberId}` : ''}`),
  createRule: (body: RuleFields) => send<MatchingRuleView>('POST', '/api/payments/rules', body),
  updateRule: (id: number, body: RuleFields) => send<MatchingRuleView>('PUT', `/api/payments/rules/${id}`, body),
  deleteRule: (id: number) => send<{ ok: true }>('DELETE', `/api/payments/rules/${id}`),
  testRules: (body: RuleTest) => send<RuleTestResult>('POST', '/api/payments/rules/test', body),
  recordPayment: (body: ManualPayment) => send<PaymentView>('POST', '/api/billing/payments', body),
  voidPayment: (id: number, reason: string) => send<PaymentView>('POST', `/api/billing/payments/${id}/void`, { reason }),
  markDeposited: (id: number, body: MarkDeposited) => send<PaymentView>('POST', `/api/billing/payments/${id}/deposited`, body),
  ledger: (memberId: number) => request<{ items: LedgerEntryView[] }>(`/api/billing/members/${memberId}/ledger`),
  adjustBalance: (memberId: number, body: BalanceAdjust) => send<MemberDetail>('POST', `/api/billing/members/${memberId}/adjust`, body),
  setBalance: (memberId: number, body: BalanceSet) => send<MemberDetail>('POST', `/api/billing/members/${memberId}/set`, body),
  emailSettings: () => request<EmailSettings>('/api/email/settings'),
  saveEmailSettings: (body: EmailSettings) => send<EmailSettings>('PUT', '/api/email/settings', body),
  emailStatus: () => request<EmailQueueStatus>('/api/email/status'),
  emailQueue: (q: { status?: string; kind?: string; page?: number }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
    return request<{ items: EmailQueueItem[]; total: number; page: number; pageSize: number }>(`/api/email/queue?${params.toString()}`);
  },
  emailItem: (id: number) => request<EmailQueueItem & { html: string; text: string }>(`/api/email/queue/${id}`),
  retryEmail: (id: number) => send<{ ok: true }>('POST', `/api/email/queue/${id}/retry`),
  cancelEmail: (id: number) => send<{ ok: true }>('POST', `/api/email/queue/${id}/cancel`),
  drainNow: () => send<{ sent: number; failed: number; retried: number; dryRun: number; skipped?: string }>('POST', '/api/email/drain'),
  packs: () => request<{ items: PackSummary[] }>('/api/templates'),
  pack: (id: string) => request<PackDetail>(`/api/templates/${id}`),
  packFile: (id: string, path: string) => request<{ content: string }>(`/api/templates/${id}/file?path=${encodeURIComponent(path)}`),
  savePackFile: (id: string, path: string, content: string) => send<PackDetail>('PUT', `/api/templates/${id}/file`, { path, content }),
  deletePackFile: (id: string, path: string) => request<PackDetail>(`/api/templates/${id}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  duplicatePack: (fromPackId: string, name: string) => send<PackDetail>('POST', '/api/templates', { fromPackId, name }),
  deletePack: (id: string) => send<{ ok: true }>('DELETE', `/api/templates/${id}`),
  activatePack: (id: string) => send<{ ok: true }>('POST', `/api/templates/${id}/activate`),
  savePackTheme: (id: string, values: Record<string, string>) => send<PackDetail>('PUT', `/api/templates/${id}/theme`, { values }),
  previewPack: (body: PreviewRequest) => send<EmailPreview & { problems: PackProblem[] }>('POST', '/api/templates/preview', body),
  testPack: (id: string, kind: TemplateKind) => send<{ queued: boolean; to: string }>('POST', `/api/templates/${id}/test`, { kind }),
  uploadPack: (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<PackDetail>('/api/templates/upload', { method: 'POST', body });
  },
  uploadPackAsset: (id: string, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<PackDetail>(`/api/templates/${id}/assets`, { method: 'POST', body });
  },
  announcements: () => request<{ items: AnnouncementView[]; footer: string }>('/api/announcements'),
  announcement: (id: number) => request<AnnouncementView>(`/api/announcements/${id}`),
  createAnnouncement: (body: AnnouncementDraft) => send<AnnouncementView>('POST', '/api/announcements', body),
  updateAnnouncement: (id: number, body: AnnouncementDraft) => send<AnnouncementView>('PUT', `/api/announcements/${id}`, body),
  deleteAnnouncement: (id: number) => send<{ ok: true }>('DELETE', `/api/announcements/${id}`),
  audienceRecipients: (audience: Audience) => send<{ items: AnnouncementRecipient[] }>('POST', '/api/announcements/recipients', { audience }),
  previewAnnouncement: (body: AnnouncementDraft) => send<EmailPreview>('POST', '/api/announcements/preview', body),
  sendAnnouncement: (id: number, confirmRecipients: number) => send<AnnouncementView>('POST', `/api/announcements/${id}/send`, { confirmRecipients }),
  cancelAnnouncement: (id: number) => send<AnnouncementView>('POST', `/api/announcements/${id}/cancel`),
  announcementRecipients: (id: number) => request<{ items: AnnouncementRecipientStatus[] }>(`/api/announcements/${id}/recipients`),
  servers: () => request<{ items: Array<{ id: number; name: string; type: string }> }>('/api/media/servers'),
  mappingPresets: () => request<{ items: MappingPreset[] }>('/api/csv/presets'),
  saveMappingPresets: (items: MappingPreset[]) => send<{ items: MappingPreset[] }>('PUT', '/api/csv/presets', { items }),

  systemStatus: () => request<SystemStatus>('/api/system/status'),
  backups: () => request<{ items: BackupRun[] }>('/api/system/backups'),
  backupNow: () => send<{ run: BackupRun }>('POST', '/api/system/backups'),
  backupRetention: () => request<BackupRetention>('/api/system/backup-retention'),
  setBackupRetention: (value: BackupRetention) => send<BackupRetention>('PUT', '/api/system/backup-retention', value),
};
