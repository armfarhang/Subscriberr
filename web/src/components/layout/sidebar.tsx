import type { Me } from '@subscriberr/shared';
import { ArrowLeftRight, LogOut } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { googleStartUrl } from '@/lib/api';
import { cn } from '@/lib/utils';
import { NAV } from './nav';

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 font-semibold tracking-tight', className)}>
      <img src="/favicon.svg" alt="" className="h-7 w-7 rounded-md" />
      <span>Subscriberr</span>
    </div>
  );
}

/** The current workspace (= Google account). Another workspace = sign in with another Google account (§5.5). */
function WorkspaceSwitcher({ me, canSwitch }: { me: Me; canSwitch: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3 rounded-md border bg-card/50 px-3 py-2" title="Workspace (one per Google account)">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold uppercase text-primary">
          {me.email.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{me.email}</div>
          <div className="text-xs capitalize text-muted-foreground">{me.role} workspace</div>
        </div>
      </div>
      {canSwitch && (
        <a href={googleStartUrl({ switchAccount: true })} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden /> Switch Google account
        </a>
      )}
    </div>
  );
}

export function Sidebar({ me, canSwitch, onNavigate, onSignOut }: { me: Me; canSwitch: boolean; onNavigate?: () => void; onSignOut: () => void }) {
  return (
    <div className="flex h-full flex-col gap-4 bg-sidebar p-4 text-sidebar-foreground">
      <Logo className="px-1 text-foreground" />
      <WorkspaceSwitcher me={me} canSwitch={canSwitch} />
      <nav className="flex-1 space-y-5 overflow-y-auto" aria-label="Main">
        {NAV.map((group) => (
          <div key={group.label}>
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">{group.label}</div>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                        isActive && 'bg-accent font-medium text-accent-foreground',
                      )
                    }
                  >
                    <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={onSignOut}>
        <LogOut /> Sign out
      </Button>
    </div>
  );
}
