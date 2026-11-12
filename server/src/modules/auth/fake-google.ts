import { Hono } from 'hono';
import { randomToken } from '../../core/crypto.js';
import type { Clock } from '../../core/time.js';
import { type AuthorizationRequest, type GoogleAuthProvider, type GoogleTokenResult, pkceChallenge, type RefreshResult, SIGN_IN_SCOPES } from './google.js';

// Fake Google for demo mode and tests (Spec §17). It behaves like the real OAuth flow — consent
// page, single-use authorization code, PKCE verification, refresh tokens that can be revoked —
// but everything stays inside this process. It is never used when real credentials are set and
// demo mode is off.

export const FAKE_GOOGLE_PATH = '/dev/google/authorize';
const CODE_TTL_MS = 5 * 60_000;

interface IssuedCode {
  email: string;
  challenge: string;
  grantGmail: boolean;
  emailVerified: boolean;
  expiresAt: number;
}

export class FakeGoogleAuthProvider implements GoogleAuthProvider {
  readonly kind = 'fake' as const;
  private readonly codes = new Map<string, IssuedCode>();
  private readonly invalid = new Set<string>();
  /** Every token the app asked to revoke (tests assert on this). */
  readonly revoked: string[] = [];
  /** Every refresh token handed out, newest last. */
  readonly issuedRefreshTokens: string[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly clock: Clock,
  ) {}

  authorizationUrl(request: AuthorizationRequest): string {
    const params = new URLSearchParams({ state: request.state, code_challenge: request.codeChallenge, code_challenge_method: 'S256' });
    if (request.loginHint) params.set('login_hint', request.loginHint);
    return `${this.baseUrl}${FAKE_GOOGLE_PATH}?${params.toString()}`;
  }

  /** What the consent page does when the user clicks "Allow". */
  issueCode(input: { email: string; codeChallenge: string; grantGmail?: boolean; emailVerified?: boolean }): string {
    const code = `fake-code-${randomToken(16)}`;
    this.codes.set(code, {
      email: input.email.trim().toLowerCase(),
      challenge: input.codeChallenge,
      grantGmail: input.grantGmail ?? true,
      emailVerified: input.emailVerified ?? true,
      expiresAt: this.clock.now().getTime() + CODE_TTL_MS,
    });
    return code;
  }

  async exchangeCode({ code, codeVerifier }: { code: string; codeVerifier: string }): Promise<GoogleTokenResult> {
    const issued = this.codes.get(code);
    this.codes.delete(code); // single use, like Google
    if (!issued || issued.expiresAt < this.clock.now().getTime()) throw new Error('invalid_grant: unknown, used or expired authorization code');
    if (pkceChallenge(codeVerifier) !== issued.challenge) throw new Error('invalid_grant: PKCE verification failed');
    const refreshToken = `fake-refresh-${randomToken(16)}`;
    this.issuedRefreshTokens.push(refreshToken);
    return {
      identity: { sub: `fake:${issued.email}`, email: issued.email, emailVerified: issued.emailVerified, name: null },
      refreshToken,
      scopes: issued.grantGmail ? [...SIGN_IN_SCOPES] : ['openid', 'email', 'profile'],
    };
  }

  /** Simulates Google revoking/expiring a token (e.g. the 7-day Testing-mode expiry). */
  invalidate(token: string): void {
    this.invalid.add(token);
  }

  async refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
    if (this.invalid.has(refreshToken) || this.revoked.includes(refreshToken)) {
      return { ok: false, reason: 'invalid_grant', message: 'invalid_grant: Token has been expired or revoked.' };
    }
    return { ok: true };
  }

  async revokeToken(token: string): Promise<void> {
    this.revoked.push(token);
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * The fake consent page. Only mounted when the fake provider is active (demo mode). The page
 * always returns to the app's own callback URL — never to a URL taken from the request.
 */
export function fakeGoogleRoutes(provider: FakeGoogleAuthProvider, options: { callbackUrl: string; allowedOrigin: string }) {
  const app = new Hono();

  app.get('/authorize', (c) => {
    const state = c.req.query('state') ?? '';
    const challenge = c.req.query('code_challenge') ?? '';
    const hint = c.req.query('login_hint') ?? 'demo@example.com';
    if (!state || !challenge) return c.text('Missing state or code_challenge', 400);
    return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fake Google sign-in</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1117;color:#e7e9ee;font:15px system-ui,sans-serif}
  form{width:min(380px,92vw);background:#181b24;border:1px solid #2a2f3d;border-radius:12px;padding:28px;display:grid;gap:14px}
  h1{font-size:18px;margin:0} p{margin:0;color:#9aa1b2;font-size:13px;line-height:1.5}
  input[type=email]{padding:9px 10px;border-radius:8px;border:1px solid #39404f;background:#0f1117;color:inherit;font:inherit}
  label{display:flex;gap:8px;align-items:center;font-size:14px}
  .row{display:flex;gap:8px;justify-content:flex-end} button{padding:8px 14px;border-radius:8px;border:0;font:inherit;cursor:pointer}
  .allow{background:#7c6cfc;color:#fff} .deny{background:#2a2f3d;color:#e7e9ee}
  .tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;background:#3b2f0b;color:#f5c451}
</style></head><body>
<form method="post" action="${FAKE_GOOGLE_PATH}">
  <span class="tag">DEMO — fake Google</span>
  <h1>Sign in to Subscriberr</h1>
  <p>This page imitates Google's consent screen so the full sign-in flow can be tested without a real Google account. Nothing leaves this computer.</p>
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(challenge)}">
  <label for="email" style="display:block">Google account email</label>
  <input id="email" type="email" name="email" required value="${escapeHtml(hint)}">
  <label><input type="checkbox" name="gmail" value="1" checked> Allow reading, labelling and sending Gmail</label>
  <div class="row"><button class="deny" name="decision" value="deny">Cancel</button><button class="allow" name="decision" value="allow">Allow</button></div>
</form></body></html>`);
  });

  app.post('/authorize', async (c) => {
    const origin = c.req.header('origin');
    if (origin && origin !== options.allowedOrigin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return c.text('Cross-origin request refused', 403);
    }
    const body = await c.req.parseBody();
    const state = typeof body.state === 'string' ? body.state : '';
    const challenge = typeof body.code_challenge === 'string' ? body.code_challenge : '';
    const email = typeof body.email === 'string' ? body.email : '';
    const back = new URL(options.callbackUrl);
    back.searchParams.set('state', state);
    if (body.decision !== 'allow') {
      back.searchParams.set('error', 'access_denied');
    } else {
      if (!challenge || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.text('A valid email is required', 400);
      back.searchParams.set('code', provider.issueCode({ email, codeChallenge: challenge, grantGmail: body.gmail === '1' }));
    }
    return c.redirect(back.toString(), 302);
  });

  return app;
}
