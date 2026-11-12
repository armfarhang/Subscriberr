import { describe, expect, it } from 'vitest';
import { JellyfinProvider } from '../../src/modules/media/jellyfin.js';
import { PlexProvider } from '../../src/modules/media/plex.js';
import { xmlElements } from '../../src/modules/media/xml.js';

// Mocked HTTP: (method, url) → response. Records every request so tests can assert exactly what
// would be sent to plex.tv / Jellyfin. Nothing here touches the network.
function mockFetch(routes: Record<string, (body: unknown) => { status?: number; body: string | object }>) {
  const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, headers: init.headers as Record<string, string> });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key]!(body);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const PLEX_SERVER = 'http://plex.local:32400';
const SHARED = `<?xml version="1.0"?><MediaContainer>
  <SharedServer id="9001" userID="101" username="payer.one" email="payer1@example.com" accepted="1">
    <Section id="501" key="1" title="Movies" shared="1"/><Section id="502" key="2" title="TV" shared="1"/><Section id="503" key="3" title="Music" shared="0"/>
  </SharedServer>
  <SharedServer id="9002" userID="102" username="pat" email="pat@example.com" accepted="1">
    <Section id="501" key="1" title="Movies" shared="0"/>
  </SharedServer>
  <SharedServer id="9003" userID="0" username="" email="invited@example.com" accepted="0"/>
</MediaContainer>`;

function plex() {
  const m = mockFetch({
    [`GET ${PLEX_SERVER}/identity`]: () => ({ body: '<MediaContainer machineIdentifier="abc123def" version="1.40"/>' }),
    'GET https://plex.tv/api/v2/user': () => ({ body: { id: 1, username: 'owner', email: 'owner@example.com' } }),
    'GET https://plex.tv/api/servers/abc123def/shared_servers': () => ({ body: SHARED }),
    'GET https://plex.tv/api/servers/abc123def': () => ({ body: '<MediaContainer><Server><Section id="501" key="1" title="Movies"/><Section id="502" key="2" title="TV &amp; Shows"/></Server></MediaContainer>' }),
    'PUT https://plex.tv/api/servers/abc123def/shared_servers/': () => ({ body: {} }),
  });
  return { ...m, provider: new PlexProvider(PLEX_SERVER, { token: 'plex-token-xyz' }, m.impl) };
}

describe('Plex adapter (Spec §10.3, mocked plex.tv)', () => {
  it('lists the owner as admin, accepted shares as users and unaccepted invites as pending', async () => {
    const { provider, calls } = plex();
    expect(await provider.listUsers()).toEqual([
      { id: '1', username: 'owner', email: 'owner@example.com', isAdmin: true },
      { id: '101', username: 'payer.one', email: 'payer1@example.com', isAdmin: false },
      { id: '102', username: 'pat', email: 'pat@example.com', isAdmin: false },
    ]);
    expect(await provider.listPendingInvites()).toEqual([{ id: '9003', email: 'invited@example.com' }]);
    expect(calls[0]!.headers['X-Plex-Token']).toBe('plex-token-xyz');
    expect(await provider.listLibraries()).toEqual([
      { id: '501', name: 'Movies' },
      { id: '502', name: 'TV & Shows' },
    ]);
  });

  it('reads access from the shared sections (drift), grants and revokes by setting the section list', async () => {
    const { provider, calls } = plex();
    const user = { id: '101', username: 'payer.one', isAdmin: false };
    expect(await provider.getAccess(user)).toEqual({ state: 'granted', libraryIds: ['501', '502'] });
    expect(await provider.getAccess({ id: '102', username: 'pat', isAdmin: false })).toEqual({ state: 'revoked', libraryIds: [] });
    await provider.grantAccess(user, ['501']);
    await provider.revokeAccess(user);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => [c.url, c.body])).toEqual([
      ['https://plex.tv/api/servers/abc123def/shared_servers/9001', { server_id: 'abc123def', shared_server: { library_section_ids: [501] } }],
      ['https://plex.tv/api/servers/abc123def/shared_servers/9001', { server_id: 'abc123def', shared_server: { library_section_ids: [] } }],
    ]);
  });

  it('never modifies the owner and refuses users without an accepted share', async () => {
    const { provider, calls } = plex();
    await expect(provider.grantAccess({ id: '1', username: 'owner', isAdmin: true }, ['501'])).rejects.toThrow(/owner/);
    await expect(provider.revokeAccess({ id: '777', username: 'ghost', isAdmin: false })).rejects.toThrow(/no accepted share/);
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('reports a refused change instead of hiding it', async () => {
    const m = mockFetch({
      [`GET ${PLEX_SERVER}/identity`]: () => ({ body: '<MediaContainer machineIdentifier="abc123def"/>' }),
      'GET https://plex.tv/api/servers/abc123def/shared_servers': () => ({ body: SHARED }),
      'PUT https://plex.tv/': () => ({ status: 400, body: 'empty list not allowed' }),
    });
    await expect(new PlexProvider(PLEX_SERVER, { token: 't0ken-1234' }, m.impl).revokeAccess({ id: '101', username: 'payer.one', isAdmin: false })).rejects.toThrow(/Plex refused the library change \(400\)/);
  });

  it('xml reader decodes entities and nested elements', () => {
    expect(xmlElements('<A x="1"><B y="a &amp; b"/></A><A x="2"/>', 'A').map((e) => [e.attrs.x, xmlElements(e.inner, 'B').map((b) => b.attrs.y)])).toEqual([
      ['1', ['a & b']],
      ['2', []],
    ]);
  });
});

describe('Jellyfin adapter (Spec §10.4, mocked API)', () => {
  const JF = 'http://jf.local:8096';
  function jellyfin(options = {}) {
    const policies: Record<string, Record<string, unknown>> = {
      a1: { IsAdministrator: true, EnableAllFolders: true },
      u1: { IsAdministrator: false, EnableAllFolders: false, EnabledFolders: ['movies'], IsDisabled: false, MaxActiveSessions: 2 },
      u2: { IsAdministrator: false, EnableAllFolders: true },
    };
    const m = mockFetch({
      [`GET ${JF}/System/Info`]: () => ({ body: { ServerName: 'Home', Version: '10.10.3' } }),
      [`GET ${JF}/Users/`]: () => ({ body: {} }),
      [`GET ${JF}/Users`]: () => ({ body: [{ Id: 'a1', Name: 'admin', Policy: policies.a1 }, { Id: 'u1', Name: 'payerone', Policy: policies.u1 }, { Id: 'u2', Name: 'sam', Policy: policies.u2 }] }),
      [`GET ${JF}/Library/VirtualFolders`]: () => ({ body: [{ Name: 'Movies', ItemId: 'movies' }, { Name: 'Shows', ItemId: 'shows' }] }),
      [`POST ${JF}/Users/u1/Policy`]: () => ({ body: '' }),
      [`GET ${JF}/Sessions`]: () => ({ body: [{ Id: 's1', UserId: 'u1' }, { Id: 's2', UserId: 'u2' }] }),
      [`POST ${JF}/Sessions/s1/Playing/Stop`]: () => ({ body: '' }),
    });
    // Per-user GETs answer with that user's policy.
    const impl = (async (input: string | URL, init?: RequestInit) => {
      const u = /\/Users\/(\w+)$/.exec(String(input));
      if (u && (init?.method ?? 'GET') === 'GET') {
        m.calls.push({ method: 'GET', url: String(input), body: undefined, headers: init?.headers as Record<string, string> });
        return new Response(JSON.stringify({ Id: u[1], Name: u[1], Policy: policies[u[1]!] }));
      }
      return m.impl(input, init);
    }) as typeof fetch;
    return { calls: m.calls, provider: new JellyfinProvider(JF, 'jf-api-key-123', options, impl) };
  }

  it('lists users (admins flagged) and libraries, reads access including "all folders"', async () => {
    const { provider, calls } = jellyfin();
    expect((await provider.listUsers()).map((u) => [u.id, u.isAdmin])).toEqual([
      ['a1', true],
      ['u1', false],
      ['u2', false],
    ]);
    expect(calls[0]!.headers['X-Emby-Token']).toBe('jf-api-key-123');
    expect(await provider.getAccess({ id: 'u1', username: 'payerone', isAdmin: false })).toEqual({ state: 'granted', libraryIds: ['movies'] });
    expect(await provider.getAccess({ id: 'u2', username: 'sam', isAdmin: false })).toEqual({ state: 'granted', libraryIds: ['movies', 'shows'] });
  });

  it('grant and revoke send the full policy with only the folder fields changed; optional disable and session stop', async () => {
    const { provider, calls } = jellyfin({ disableOnRevoke: true, endSessionsOnRevoke: true });
    const user = { id: 'u1', username: 'payerone', isAdmin: false };
    await provider.grantAccess(user, ['movies', 'shows']);
    await provider.revokeAccess(user);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts[0]).toMatchObject({ url: `${JF}/Users/u1/Policy`, body: { EnableAllFolders: false, EnabledFolders: ['movies', 'shows'], IsDisabled: false, MaxActiveSessions: 2 } });
    expect(posts[1]).toMatchObject({ url: `${JF}/Users/u1/Policy`, body: { EnabledFolders: [], IsDisabled: true, MaxActiveSessions: 2 } });
    expect(posts[2]!.url).toBe(`${JF}/Sessions/s1/Playing/Stop`); // only this user's session
    expect(posts).toHaveLength(3);
  });

  it('never modifies an administrator, even if the caller did not flag it', async () => {
    const { provider, calls } = jellyfin();
    await expect(provider.revokeAccess({ id: 'a1', username: 'admin', isAdmin: false })).rejects.toThrow(/administrator/);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
