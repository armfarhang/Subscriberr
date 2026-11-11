// The narrow Gmail surface the app needs. The real implementation (googleapis) arrives with
// OAuth in Milestones 2/5; demo mode and tests use FakeGmail (fake.ts).

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailRawMessage extends GmailMessageRef {
  labels: string[];
  /** Gmail's internal received time. */
  internalDate: Date;
  /** The full RFC 822 message. */
  raw: Buffer;
}

export interface GmailListQuery {
  /** Exact sender addresses (lower-case), e.g. notify@payments.interac.ca. */
  from: string[];
  /** Skip messages that already carry this label (e.g. Subscriberr/Processed). */
  withoutLabel?: string;
  /** Only messages received at or after this instant. */
  after?: Date;
}

export interface GmailClient {
  listMessages(query: GmailListQuery): Promise<GmailMessageRef[]>;
  getMessage(id: string): Promise<GmailRawMessage>;
  /** Adds a label, creating it if needed. Never deletes or archives mail. */
  addLabel(id: string, label: string): Promise<void>;
  /** Sends a fully built RFC 822 message from the connected account. */
  send(raw: Buffer): Promise<{ id: string }>;
}

export const INTERAC_SENDER = 'notify@payments.interac.ca';
export const LABEL_PROCESSED = 'Subscriberr/Processed';
export const LABEL_NEEDS_REVIEW = 'Subscriberr/NeedsReview';
