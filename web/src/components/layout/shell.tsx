import type { Me, PublicConfig } from '@subscriberr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical, Menu, X } from 'lucide-react';
import * as React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { api, googleStartUrl } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { NAV_ITEMS } from './nav';
import { Logo, Sidebar } from './sidebar';
import { ThemeToggle } from './theme';

/** App frame: fixed sidebar on desktop, slide-over drawer on phones, top bar with the page title. */
export function Shell({ me, config }: { me: Me; config: PublicConfig }) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const location = useLocation();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });

  const current = NAV_ITEMS.find((i) => (i.to === '/' ? location.pathname === '/' : location.pathname.startsWith(i.to)));
  React.useEffect(() => {
    document.title = current ? `${current.label} · Subscriberr` : 'Subscriberr';
  }, [current]);

  // A new page starts at the top (query-string changes such as list filters keep the position).
  React.useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  React.useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r lg:block">
        <Sidebar me={me} canSwitch={config.googleSignIn} onSignOut={() => signOut.mutate()} />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r shadow-xl">
            <Sidebar me={me} canSwitch={config.googleSignIn} onNavigate={() => setDrawerOpen(false)} onSignOut={() => signOut.mutate()} />
            <Button variant="ghost" size="icon" className="absolute right-2 top-3" onClick={() => setDrawerOpen(false)} aria-label="Close navigation">
              <X />
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <Logo className="lg:hidden" />
          <h1 className="hidden text-base font-semibold lg:block">{current?.label ?? 'Subscriberr'}</h1>
          <div className="ml-auto flex items-center gap-2">
            {config.demoMode && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning" title="Fake Gmail, fake Plex/Jellyfin and fake sign-in. No real service is contacted.">
                <FlaskConical className="h-3.5 w-3.5" aria-hidden /> Demo mode
              </span>
            )}
            <ThemeToggle />
          </div>
        </header>
        {me.gmailStatus !== 'connected' && (
          <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2.5 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 flex-1">
              {me.gmailStatus === 'error'
                ? 'Gmail credentials cannot be read. Scanning and sending are paused until you reconnect Google.'
                : 'Gmail is disconnected. Scanning for e-Transfers and sending emails are paused until you reconnect.'}
            </span>
            {config.googleSignIn && (
              <Button asChild size="sm" variant="outline">
                <a href={googleStartUrl()}>Reconnect Google</a>
              </Button>
            )}
          </div>
        )}
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
