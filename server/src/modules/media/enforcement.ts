import type { MemberStatus, SyncPlanItem } from '@subscriberr/shared';
import type { ExternalUser, MediaServerProvider } from './provider.js';

// Enforcement (Spec §10.2). Depends ONLY on the provider interface (§4.1 rule 2). Computes the
// desired state per linked member, compares it with what the server reports, and changes the
// server only where they differ. Hard guards: never touch an admin/owner account or a user the
// server does not list; never "grant" an empty library set.

export interface LinkInput {
  memberId: number;
  displayName: string;
  memberStatus: MemberStatus;
  externalUserId: string;
  externalUsername: string | null;
  libraryOverride: string[] | null;
}

export type Desired = { state: 'granted' | 'revoked'; libraryIds: string[] } | null;

/** Paid (active / grace) → access; expired / archived → none; paused → left as it is (§8.3). */
export function desiredFor(status: MemberStatus, override: string[] | null, defaults: string[]): Desired {
  if (status === 'paused') return null;
  if (status === 'active' || status === 'grace') return { state: 'granted', libraryIds: [...(override ?? defaults)].sort() };
  return { state: 'revoked', libraryIds: [] };
}

const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export interface Plan {
  items: SyncPlanItem[];
  users: Map<string, ExternalUser>;
}

export async function planSync(provider: MediaServerProvider, links: LinkInput[], defaults: string[]): Promise<Plan> {
  const users = new Map((await provider.listUsers()).map((u) => [u.id, u]));
  const items: SyncPlanItem[] = [];
  for (const l of links) {
    const base = { memberId: l.memberId, displayName: l.displayName, memberStatus: l.memberStatus, externalUserId: l.externalUserId, externalUsername: l.externalUsername };
    const user = users.get(l.externalUserId);
    const desired = desiredFor(l.memberStatus, l.libraryOverride, defaults);
    if (!user) {
      items.push({ ...base, current: null, desired, action: 'skip', reason: 'This account is no longer a (linkable) user on the server', error: 'user not found on server' });
      continue;
    }
    if (user.isAdmin) {
      items.push({ ...base, current: null, desired, action: 'skip', reason: 'The server admin/owner account is never changed' });
      continue;
    }
    let current;
    try {
      current = await provider.getAccess(user);
    } catch (err) {
      items.push({ ...base, current: null, desired, action: 'skip', reason: 'Could not read the current access', error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!desired) {
      items.push({ ...base, current, desired, action: 'none', reason: 'Paused: access is left as it is' });
      continue;
    }
    if (desired.state === 'granted') {
      if (desired.libraryIds.length === 0) {
        items.push({ ...base, current, desired, action: 'skip', reason: 'No libraries chosen: set the server’s default libraries or the member’s own', error: 'no libraries configured' });
        continue;
      }
      const drift = current.state !== 'granted' || !same(current.libraryIds, desired.libraryIds);
      items.push({ ...base, current, desired, action: drift ? 'grant' : 'none', reason: drift ? (current.state === 'granted' ? 'Libraries differ from the plan (drift)' : 'Paid: access should be on') : 'Up to date' });
    } else {
      const drift = current.state !== 'revoked';
      items.push({ ...base, current, desired, action: drift ? 'revoke' : 'none', reason: drift ? `${l.memberStatus === 'archived' ? 'Archived' : 'Expired'}: access should be off` : 'Up to date' });
    }
  }
  return { items, users };
}

export async function applyItem(provider: MediaServerProvider, item: SyncPlanItem, user: ExternalUser, opts: { endSessions?: boolean } = {}): Promise<void> {
  if (user.isAdmin) throw new Error('Refusing to modify an admin/owner account');
  if (item.action === 'grant') await provider.grantAccess(user, item.desired!.libraryIds);
  else if (item.action === 'revoke') await provider.revokeAccess(user, opts);
}
