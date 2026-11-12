import { describe, expect, it } from 'vitest';
import { INTERAC_SENDER, LABEL_PROCESSED } from '../../src/modules/gmail/client.js';
import { createGmailClientFactory } from '../../src/modules/gmail/factory.js';
import { FakeGmail } from '../../src/modules/gmail/fake.js';
import { createMediaProviderFactory } from '../../src/modules/media/factory.js';
import { createDemoJellyfin, createDemoPlex, type FakeMediaServer } from '../../src/modules/media/fake.js';

describe('fake Gmail (demo mode)', () => {
  it('serves the three Interac fixtures and hides the bank alert from the Interac query', async () => {
    const gmail = await FakeGmail.fromFixtures();
    const interac = await gmail.listMessages({ from: [INTERAC_SENDER] });
    expect(interac.map((m) => m.id)).toEqual([
      'fake-legacy-sent-you-money-03', // 2017
      'fake-autodeposit-with-memo-02', // July 2026
      'fake-autodeposit-01', // November 2026
    ]);
    const bank = await gmail.listMessages({ from: ['infoalerts@scotiabank.com'] });
    expect(bank).toHaveLength(1);
  });

  it('returns the raw message and supports labels and date bounds', async () => {
    const gmail = await FakeGmail.fromFixtures();
    const msg = await gmail.getMessage('fake-autodeposit-01');
    expect(msg.raw.toString('latin1')).toContain('X-PaymentKey: C1AAAAAAAAA1');
    expect(msg.internalDate.toISOString()).toBe('2026-11-01T13:36:40.000Z');

    await gmail.addLabel(msg.id, LABEL_PROCESSED);
    await gmail.addLabel(msg.id, LABEL_PROCESSED);
    expect((await gmail.getMessage(msg.id)).labels.filter((l) => l === LABEL_PROCESSED)).toHaveLength(1);
    const pending = await gmail.listMessages({ from: [INTERAC_SENDER], withoutLabel: LABEL_PROCESSED, after: new Date('2026-01-01T00:00:00Z') });
    expect(pending.map((m) => m.id)).toEqual(['fake-autodeposit-with-memo-02']);
  });

  it('records outgoing mail instead of sending it', async () => {
    const gmail = new FakeGmail();
    const { id } = await gmail.send(Buffer.from('To: someone@example.com\r\n\r\nhi'));
    expect(gmail.sent).toHaveLength(1);
    expect(gmail.sent[0]!.id).toBe(id);
  });

  it('is only handed out in demo mode, one inbox per workspace', async () => {
    await expect(createGmailClientFactory({ seedDemo: false })(1)).rejects.toThrow(/Google is not configured/);
    const factory = createGmailClientFactory({ seedDemo: true });
    expect(await factory(1)).toBe(await factory(1));
    expect(await factory(1)).not.toBe(await factory(2));
  });
});

describe('fake media servers (demo mode)', () => {
  for (const [name, make] of [
    ['plex', createDemoPlex],
    ['jellyfin', createDemoJellyfin],
  ] as const) {
    it(`${name}: grant, revoke (keeps the account, empties libraries) and restore`, async () => {
      const server: FakeMediaServer = make();
      expect((await server.testConnection()).ok).toBe(true);
      const users = await server.listUsers();
      const libs = (await server.listLibraries()).map((l) => l.id);
      const member = users.find((u) => !u.isAdmin)!;

      const before = await server.getAccess(member);
      expect(before.state).toBe('granted');
      await server.revokeAccess(member, { endSessions: true });
      expect(await server.getAccess(member)).toEqual({ state: 'revoked', libraryIds: [] });
      expect((await server.listUsers()).some((u) => u.id === member.id)).toBe(true);
      await server.grantAccess(member, before.libraryIds);
      expect(await server.getAccess(member)).toEqual(before);
      expect(server.calls.map((c) => c.op)).toEqual(['revoke', 'grant']);

      await expect(server.grantAccess(member, [...libs, 'nope'])).rejects.toThrow(/unknown libraries/);
    });

    it(`${name}: refuses to modify the admin account`, async () => {
      const server = make();
      const admin = (await server.listUsers()).find((u) => u.isAdmin)!;
      await expect(server.revokeAccess(admin)).rejects.toThrow(/admin/);
      await expect(server.grantAccess(admin, [])).rejects.toThrow(/admin/);
      expect(server.calls).toEqual([]);
    });
  }

  it('plex: pending invitations are not linkable users', async () => {
    const plex = createDemoPlex();
    expect(plex.pendingInvites).toHaveLength(1);
    const emails = (await plex.listUsers()).map((u) => u.email);
    expect(emails).not.toContain(plex.pendingInvites[0]!.email);
  });

  it('fake:// servers exist only in demo mode; real servers need their credentials', () => {
    const demo = createMediaProviderFactory({ seedDemo: true });
    const plex = demo({ id: 1, type: 'plex', baseUrl: 'fake://plex' });
    expect(demo({ id: 1, type: 'plex', baseUrl: 'fake://plex' })).toBe(plex);
    expect(() => createMediaProviderFactory({ seedDemo: false })({ id: 1, type: 'plex', baseUrl: 'fake://plex' })).toThrow(/demo mode/);
    expect(() => demo({ id: 2, type: 'jellyfin', baseUrl: 'http://jellyfin.local:8096' })).toThrow(/no credentials/);
  });
});
