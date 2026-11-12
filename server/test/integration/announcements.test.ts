import { describe, expect, it } from 'vitest';
import type { AnnouncementRecipient, AnnouncementRecipientStatus, AnnouncementView, EmailPreview } from '@subscriberr/shared';
import { DEFAULT_EMAIL_SETTINGS } from '@subscriberr/shared';
import { silentLogger } from '../../src/core/logger.js';
import { seedDemo } from '../../src/db/seed-demo.js';
import { drainAll } from '../../src/modules/email/drain.js';
import { FakeGmail } from '../../src/modules/gmail/fake.js';
import { allowEmail, createWorld, testApp } from '../helpers/env.js';
import { CSRF, cookieFrom } from '../helpers/http.js';

async function setup() {
  const world = createWorld({ start: '2026-11-12T15:00:00Z' });
  seedDemo(world.db, world.clock.now(), 'America/Toronto');
  const inbox = await FakeGmail.fromFixtures();
  const { app } = testApp(world, { gmail: async () => inbox });
  const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: '{}' });
  const cookie = cookieFrom(res, 'subscriberr_session')!;
  const json = async <T>(p: string, init: { method?: string; body?: unknown } = {}, status = 200, headers = { ...CSRF, cookie }): Promise<T> => {
    const r = await app.request(p, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const text = await r.text();
    expect(r.status, `${init.method ?? 'GET'} ${p}: ${text.slice(0, 400)}`).toBe(status);
    return JSON.parse(text) as T;
  };
  const drain = () => drainAll(world.ctx, { clock: world.clock, log: silentLogger, gmail: async () => inbox, throttleMs: 0 });
  return { world, app, json, inbox, drain };
}

const draft = (extra: Record<string, unknown> = {}) => ({
  subject: 'Hi {{member.display_name}}: movie night',
  body: '<p>Hello {{member.display_name}}, <strong>new 4K library</strong>!</p><script>alert(1)</script><p onclick="x()">Pay {{amount_expected}}</p>',
  audience: { type: 'non_archived' },
  footer: '<p>Reply to opt out.</p>',
  ...extra,
});

describe('announcements (Spec §9.4)', () => {
  it('drafts are sanitized and validated; audiences resolve with exclusions', async () => {
    const { json, world } = await setup();
    await json('/api/announcements', { method: 'POST', body: draft({ body: '<p>{{member.email}}</p>' }) }, 422);
    const a = await json<AnnouncementView>('/api/announcements', { method: 'POST', body: draft() }, 201);
    expect(a.status).toBe('draft');
    expect(a.body).toBe('<p>Hello {{member.display_name}}, <strong>new 4K library</strong>!</p><p>Pay {{amount_expected}}</p>');

    const recipients = async (audience: unknown) => (await json<{ items: AnnouncementRecipient[] }>('/api/announcements/recipients', { method: 'POST', body: { audience } })).items;
    const all = await recipients({ type: 'non_archived' });
    expect(all.map((r) => [r.displayName, r.excluded])).toEqual([
      ['Jordan Example', null],
      ['Pat (cousin)', null],
      ['Payer One', null],
      ['Riley (no email yet)', 'no email on file'],
      ['Sam Payer', null],
    ]);
    world.db.prepare(`UPDATE members SET paid_through = '2026-11-20', status = 'active' WHERE id IN (1, 2)`).run();
    world.db.prepare(`UPDATE members SET paid_through = '2026-12-30', status = 'active' WHERE id = 4`).run();
    expect((await recipients({ type: 'active' })).map((r) => r.memberId)).toEqual([4, 2, 1]);
    expect((await recipients({ type: 'expiring', days: 10 })).map((r) => r.memberId)).toEqual([2, 1]);
    expect((await recipients({ type: 'status', statuses: ['expired'] })).map((r) => r.memberId)).toEqual([5, 3]);
    expect((await recipients({ type: 'server', serverId: 2 })).map((r) => r.displayName)).toEqual(['Jordan Example', 'Payer One', 'Sam Payer']); // Jellyfin
    expect((await recipients({ type: 'picked', memberIds: [3, 999] })).map((r) => r.memberId)).toEqual([3]);
  });

  it('preview renders the first recipient; send needs the confirmed count; copies are personalised', async () => {
    const { json, drain, inbox } = await setup();
    const a = await json<AnnouncementView>('/api/announcements', { method: 'POST', body: draft() }, 201);
    const preview = await json<EmailPreview>('/api/announcements/preview', { method: 'POST', body: draft() });
    expect(preview.subject).toBe('Hi Jordan Example: movie night');
    expect(preview.html).toContain('Hello Jordan Example');
    expect(preview.html).toContain('Reply to opt out.');
    expect(preview.html).not.toContain('<script');

    const refused = await json<{ error: { details: { recipients: number } } }>(`/api/announcements/${a.id}/send`, { method: 'POST', body: { confirmRecipients: 5 } }, 409);
    expect(refused.error.details.recipients).toBe(4); // Riley has no email
    const sending = await json<AnnouncementView>(`/api/announcements/${a.id}/send`, { method: 'POST', body: { confirmRecipients: 4 } });
    expect(sending).toMatchObject({ status: 'sending', progress: { total: 4, queued: 4, sent: 0 } });
    await json(`/api/announcements/${a.id}`, { method: 'PUT', body: draft() }, 409);
    await json(`/api/announcements/${a.id}/send`, { method: 'POST', body: { confirmRecipients: 4 } }, 409);

    await drain();
    expect(inbox.sent).toHaveLength(4);
    const subjects = inbox.sent.map((s) => /Subject: (.*)/.exec(s.raw.toString())![1]);
    expect(subjects).toEqual(expect.arrayContaining(['Hi Pat (cousin): movie night', 'Hi Payer One: movie night']));
    expect(await json<AnnouncementView>(`/api/announcements/${a.id}`)).toMatchObject({ status: 'sent', progress: { total: 4, sent: 4, queued: 0 } });
    const statuses = (await json<{ items: AnnouncementRecipientStatus[] }>(`/api/announcements/${a.id}/recipients`)).items;
    expect(statuses.every((s) => s.status === 'sent')).toBe(true);
  });

  it('an announcement larger than the cap drains across days, transactional mail first, then completes', async () => {
    const { json, drain, world, inbox } = await setup();
    await json('/api/email/settings', { method: 'PUT', body: { ...DEFAULT_EMAIL_SETTINGS, dailyCap: 3, transactionalReserve: 1 } });
    const a = await json<AnnouncementView>('/api/announcements', { method: 'POST', body: draft() }, 201);
    await json(`/api/announcements/${a.id}/send`, { method: 'POST', body: { confirmRecipients: 4 } });
    // A transactional email arrives while the announcement is queued.
    await json('/api/templates/default/test', { method: 'POST', body: { kind: 'thanks' } });
    await drain();
    expect(inbox.sent.map((s) => /Subject: (.*)/.exec(s.raw.toString())![1]![0])).toEqual(['[', 'H']); // test first, then 1 announcement (cap 3 − reserve 1)
    expect(await json<AnnouncementView>(`/api/announcements/${a.id}`)).toMatchObject({ status: 'sending', progress: { sent: 1, queued: 3 } });
    for (let day = 1; day <= 3; day++) {
      world.clock.advanceMs(24 * 3_600_000 + 60_000);
      await drain();
    }
    expect(await json<AnnouncementView>(`/api/announcements/${a.id}`)).toMatchObject({ status: 'sent', progress: { sent: 4, queued: 0 } });
  });

  it('cancel stops the remaining copies; drafts can be deleted, sent ones are history; workspace-scoped', async () => {
    const { json, app, world } = await setup();
    await json('/api/email/settings', { method: 'PUT', body: { ...DEFAULT_EMAIL_SETTINGS, dryRun: false } });
    const a = await json<AnnouncementView>('/api/announcements', { method: 'POST', body: draft() }, 201);
    await json(`/api/announcements/${a.id}/send`, { method: 'POST', body: { confirmRecipients: 4 } });
    expect(await json<AnnouncementView>(`/api/announcements/${a.id}/cancel`, { method: 'POST' })).toMatchObject({ status: 'cancelled', progress: { cancelled: 4, queued: 0 } });
    await json(`/api/announcements/${a.id}`, { method: 'DELETE' }, 409);
    const d = await json<AnnouncementView>('/api/announcements', { method: 'POST', body: draft() }, 201);
    await json(`/api/announcements/${d.id}`, { method: 'DELETE' });
    expect((await json<{ footer: string }>('/api/announcements')).footer).toBe('<p>Reply to opt out.</p>');

    allowEmail(world.db, 'operator@example.com');
    const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email: 'operator@example.com' }) });
    const other = { ...CSRF, cookie: cookieFrom(res, 'subscriberr_session')! };
    await json(`/api/announcements/${a.id}`, {}, 404, other);
    expect((await json<{ items: unknown[] }>('/api/announcements', {}, 200, other)).items).toEqual([]);
    expect((await json<{ items: AnnouncementRecipient[] }>('/api/announcements/recipients', { method: 'POST', body: { audience: { type: 'picked', memberIds: [1, 2] } } }, 200, other)).items).toEqual([]);
  });
});
