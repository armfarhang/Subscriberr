import type { AuthErrorCode, PublicConfig } from '@subscriberr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import * as React from 'react';
import { Logo } from '@/components/layout/sidebar';
import { ThemeToggle } from '@/components/layout/theme';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api, googleStartUrl } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.600-.2-2.300H12v4.400h6.500a5.500 5.500 0 0 1-2.400 3.600v3h3.900c2.300-2.100 3.500-5.200 3.500-8.700z" />
      <path fill="#34A853" d="M12 24c3.200 0 6-1.100 8-2.900l-3.900-3c-1.100.7-2.500 1.200-4.100 1.200-3.100 0-5.800-2.100-6.700-5H1.300v3.100A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.300 14.300a7.200 7.200 0 0 1 0-4.600V6.600H1.300a12 12 0 0 0 0 10.800l4-3.100z" />
      <path fill="#EA4335" d="M12 4.800c1.800 0 3.300.6 4.600 1.800l3.400-3.400A12 12 0 0 0 1.300 6.600l4 3.100c.9-2.900 3.600-4.900 6.700-4.900z" />
    </svg>
  );
}

const AUTH_ERROR_TEXT: Record<AuthErrorCode, string> = {
  not_authorized: 'This Google account is not allowed to sign in. Ask the owner to add it in Settings → Allowed Google accounts.',
  email_unverified: 'Google has not verified this account’s email address.',
  account_mismatch: 'This email belongs to a different Google account that already uses Subscriberr.',
  state_mismatch: 'The sign-in link expired or was already used. Please try again.',
  access_denied: 'Sign-in was cancelled.',
  exchange_failed: 'Google sign-in failed. Please try again.',
  rate_limited: 'Too many sign-in attempts. Wait a few minutes and try again.',
  google_unavailable: 'Google sign-in is not configured on this server.',
};

/** Reads `?auth_error=` once and removes it from the address bar. */
function useAuthError(): string | null {
  const [message] = React.useState(() => {
    const code = new URLSearchParams(window.location.search).get('auth_error') as AuthErrorCode | null;
    return code ? (AUTH_ERROR_TEXT[code] ?? 'Sign-in failed. Please try again.') : null;
  });
  React.useEffect(() => {
    if (message) window.history.replaceState(null, '', window.location.pathname);
  }, [message]);
  return message;
}

export function SignInPage({ config }: { config: PublicConfig }) {
  const queryClient = useQueryClient();
  const authError = useAuthError();
  const demoLogin = useMutation({
    mutationFn: api.devLogin,
    onSuccess: (me) => queryClient.setQueryData(queryKeys.me, me),
  });

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-6 p-8">
          <div className="space-y-2 text-center">
            <Logo className="justify-center text-xl" />
            <p className="text-sm text-muted-foreground">Paid access for your Plex and Jellyfin libraries, tracked and enforced.</p>
          </div>

          {authError && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {authError}
            </p>
          )}

          <div className="space-y-3">
            {config.googleSignIn ? (
              <Button asChild variant="outline" size="lg" className="w-full">
                <a href={googleStartUrl()}>
                  <GoogleMark /> Sign in with Google
                </a>
              </Button>
            ) : (
              <p className="text-center text-sm text-muted-foreground">Google sign-in is not configured on this server.</p>
            )}
            {config.demoMode && config.googleSignIn && (
              <p className="text-center text-xs text-muted-foreground">Demo mode: “Sign in with Google” opens a local fake Google page.</p>
            )}
            {config.devFakeLogin && (
              <>
                <Button size="lg" className="w-full" onClick={() => demoLogin.mutate()} disabled={demoLogin.isPending}>
                  <FlaskConical /> {demoLogin.isPending ? 'Signing in…' : 'Demo sign-in'}
                </Button>
                <p className="text-center text-xs text-muted-foreground">Development only: signs in as the demo owner. Nothing real is contacted.</p>
              </>
            )}
            {demoLogin.isError && (
              <p role="alert" className="text-center text-sm text-destructive">
                {demoLogin.error.message}
              </p>
            )}
          </div>
          <p className="text-center text-xs text-muted-foreground">v{config.version}</p>
        </CardContent>
      </Card>
    </div>
  );
}
