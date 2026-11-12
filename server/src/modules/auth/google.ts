import { createHash, randomBytes } from 'node:crypto';

// Google sign-in (Spec §5.1–§5.3). One consent grants identity + Gmail. The provider interface
// lets demo mode and tests use FakeGoogleAuthProvider; the real one is only built when real
// credentials are configured and demo mode is off, so tests can never reach Google.

export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_SCOPES = [GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE] as const;
export const SIGN_IN_SCOPES = ['openid', 'email', 'profile', ...GMAIL_SCOPES];

export interface GoogleIdentity {
  /** Stable Google account id (`sub` claim). */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface GoogleTokenResult {
  identity: GoogleIdentity;
  /** Present when Google issued one (we always ask with access_type=offline + prompt=consent). */
  refreshToken: string | null;
  /** Scopes the user actually granted (they can untick Gmail on the consent screen). */
  scopes: string[];
}

export type RefreshResult = { ok: true } | { ok: false; reason: 'invalid_grant' | 'error'; message: string };

export interface AuthorizationRequest {
  state: string;
  codeChallenge: string;
  loginHint?: string;
  /** Show Google's account chooser (used by "switch Google account"). */
  selectAccount?: boolean;
}

export interface GoogleAuthProvider {
  readonly kind: 'google' | 'fake';
  authorizationUrl(request: AuthorizationRequest): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<GoogleTokenResult>;
  /** Uses the refresh token once; `invalid_grant` means it was revoked or expired. */
  refreshAccessToken(refreshToken: string): Promise<RefreshResult>;
  revokeToken(token: string): Promise<void>;
}

export function hasGmailScopes(scopes: readonly string[]): boolean {
  return GMAIL_SCOPES.every((s) => scopes.includes(s));
}

/** PKCE (RFC 7636): S256 challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function isInvalidGrant(err: unknown): boolean {
  const data = (err as { response?: { data?: { error?: unknown } } })?.response?.data;
  if (data?.error === 'invalid_grant') return true;
  return err instanceof Error && /invalid_grant/i.test(err.message);
}

/** The real Google provider (googleapis is imported lazily: it is large and only needed here). */
export async function createGoogleAuthProvider(options: { clientId: string; clientSecret: string; redirectUri: string }): Promise<GoogleAuthProvider> {
  const { google } = await import('googleapis');
  const { clientId, clientSecret, redirectUri } = options;
  const client = () => new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  return {
    kind: 'google',
    authorizationUrl(request) {
      return client().generateAuthUrl({
        access_type: 'offline',
        prompt: request.selectAccount ? 'consent select_account' : 'consent',
        scope: SIGN_IN_SCOPES,
        include_granted_scopes: true,
        state: request.state,
        code_challenge: request.codeChallenge,
        // google-auth-library's CodeChallengeMethod enum is not re-exported by googleapis.
        code_challenge_method: 'S256' as never,
        ...(request.loginHint ? { login_hint: request.loginHint } : {}),
      });
    },
    async exchangeCode({ code, codeVerifier }) {
      const oauth = client();
      const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: redirectUri });
      if (!tokens.id_token) throw new Error('Google returned no ID token');
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) throw new Error('Google ID token has no subject or email');
      return {
        identity: { sub: payload.sub, email: payload.email.toLowerCase(), emailVerified: payload.email_verified === true, name: payload.name ?? null },
        refreshToken: tokens.refresh_token ?? null,
        scopes: (tokens.scope ?? '').split(/\s+/).filter(Boolean),
      };
    },
    async refreshAccessToken(refreshToken) {
      const oauth = client();
      oauth.setCredentials({ refresh_token: refreshToken });
      try {
        await oauth.getAccessToken();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: isInvalidGrant(err) ? 'invalid_grant' : 'error', message: err instanceof Error ? err.message : String(err) };
      }
    },
    async revokeToken(token) {
      await client().revokeToken(token);
    },
  };
}
