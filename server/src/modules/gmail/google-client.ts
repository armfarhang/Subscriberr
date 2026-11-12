import type { GmailClient, GmailListQuery, GmailMessageRef, GmailRawMessage } from './client.js';

// The real Gmail client (googleapis, imported lazily). Used only outside demo mode, with the
// workspace's own refresh token. It reads, labels and sends; it never deletes or archives mail.
// Verified by the owner (docs/OWNER_CHECKLIST.md): there is no Google account in the build.

export interface GoogleGmailOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Gmail search syntax for a label: lower-case, "/" and spaces become "-". */
export function labelSearchTerm(label: string): string {
  return label.toLowerCase().replace(/[/\s]+/g, '-');
}

/** The Gmail search query for a scan (exported for tests). */
export function buildQuery(query: GmailListQuery): string {
  const parts = [`from:(${query.from.join(' OR ')})`];
  if (query.withoutLabel) parts.push(`-label:${labelSearchTerm(query.withoutLabel)}`);
  if (query.after) parts.push(`after:${Math.floor(query.after.getTime() / 1000)}`);
  return parts.join(' ');
}

export async function createGoogleGmailClient(opts: GoogleGmailOptions): Promise<GmailClient> {
  const { google } = await import('googleapis');
  const auth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
  auth.setCredentials({ refresh_token: opts.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });
  const labelIds = new Map<string, string>();

  async function labelId(name: string): Promise<string> {
    const cached = labelIds.get(name);
    if (cached) return cached;
    const list = await gmail.users.labels.list({ userId: 'me' });
    for (const l of list.data.labels ?? []) if (l.name && l.id) labelIds.set(l.name, l.id);
    const found = labelIds.get(name);
    if (found) return found;
    const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
    if (!created.data.id) throw new Error(`Gmail did not return an id for label ${name}`);
    labelIds.set(name, created.data.id);
    return created.data.id;
  }

  return {
    async listMessages(query: GmailListQuery): Promise<GmailMessageRef[]> {
      const out: GmailMessageRef[] = [];
      let pageToken: string | undefined;
      do {
        const res = await gmail.users.messages.list({ userId: 'me', q: buildQuery(query), maxResults: 500, pageToken });
        for (const m of res.data.messages ?? []) if (m.id) out.push({ id: m.id, threadId: m.threadId ?? m.id });
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken && out.length < 20_000);
      return out.reverse(); // Gmail lists newest first; the pipeline works oldest first
    },
    async getMessage(id: string): Promise<GmailRawMessage> {
      const res = await gmail.users.messages.get({ userId: 'me', id, format: 'raw' });
      return {
        id,
        threadId: res.data.threadId ?? id,
        labels: res.data.labelIds ?? [],
        internalDate: new Date(Number(res.data.internalDate ?? 0)),
        raw: Buffer.from(res.data.raw ?? '', 'base64url'),
      };
    },
    async addLabel(id: string, label: string): Promise<void> {
      await gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds: [await labelId(label)] } });
    },
    async send(raw: Buffer): Promise<{ id: string }> {
      const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: raw.toString('base64url') } });
      return { id: res.data.id ?? '' };
    },
  };
}
