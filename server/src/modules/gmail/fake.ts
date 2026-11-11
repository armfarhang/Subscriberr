import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleParser } from 'mailparser';
import type { GmailClient, GmailListQuery, GmailMessageRef, GmailRawMessage } from './client.js';

// Fake Gmail for demo mode and tests (Spec §17): serves .eml files as the inbox and RECORDS
// outgoing mail instead of sending it. It never touches the network.

interface StoredMessage extends GmailRawMessage {
  fromAddress: string;
}

export interface SentMessage {
  id: string;
  raw: Buffer;
  at: Date;
}

/** fixtures/etransfer at the repository root (works from both src/ and dist/). */
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('../../../../fixtures/etransfer', import.meta.url));

export class FakeGmail implements GmailClient {
  private readonly inbox = new Map<string, StoredMessage>();
  /** Everything the app "sent", newest last. */
  readonly sent: SentMessage[] = [];

  /** Adds a raw message to the fake inbox. The id defaults to a slug of `name`. */
  async addMessage(name: string, raw: Buffer, labels: string[] = ['INBOX']): Promise<GmailMessageRef> {
    const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    const id = `fake-${name.replace(/\.eml$/i, '').replace(/[^A-Za-z0-9]+/g, '-')}`;
    const message: StoredMessage = {
      id,
      threadId: `thread-${id}`,
      labels: [...labels],
      internalDate: parsed.date ?? new Date(0),
      raw,
      fromAddress: (parsed.from?.value[0]?.address ?? '').toLowerCase(),
    };
    this.inbox.set(id, message);
    return { id, threadId: message.threadId };
  }

  /** Loads every .eml file of a directory (default: the redacted e-Transfer fixtures). */
  static async fromFixtures(dir: string = DEFAULT_FIXTURES_DIR): Promise<FakeGmail> {
    const gmail = new FakeGmail();
    for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.eml')).sort()) {
      await gmail.addMessage(file, readFileSync(path.join(dir, file)));
    }
    return gmail;
  }

  async listMessages(query: GmailListQuery): Promise<GmailMessageRef[]> {
    const from = new Set(query.from.map((a) => a.toLowerCase()));
    return [...this.inbox.values()]
      .filter((m) => from.has(m.fromAddress))
      .filter((m) => !query.withoutLabel || !m.labels.includes(query.withoutLabel))
      .filter((m) => !query.after || m.internalDate.getTime() >= query.after.getTime())
      .sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime())
      .map(({ id, threadId }) => ({ id, threadId }));
  }

  async getMessage(id: string): Promise<GmailRawMessage> {
    const m = this.inbox.get(id);
    if (!m) throw new Error(`FakeGmail: no message ${id}`);
    return { id: m.id, threadId: m.threadId, labels: [...m.labels], internalDate: m.internalDate, raw: m.raw };
  }

  async addLabel(id: string, label: string): Promise<void> {
    const m = this.inbox.get(id);
    if (!m) throw new Error(`FakeGmail: no message ${id}`);
    if (!m.labels.includes(label)) m.labels.push(label);
  }

  async send(raw: Buffer): Promise<{ id: string }> {
    const id = `fake-sent-${this.sent.length + 1}`;
    this.sent.push({ id, raw, at: new Date() });
    return { id };
  }
}
