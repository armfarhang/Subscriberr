import type { MemberSummary } from '@subscriberr/shared';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, Search, User } from 'lucide-react';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_ITEMS } from '@/components/layout/nav';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/modules/members/status';

// Command palette (Spec §13.2): Ctrl/⌘-K, type a member's custom name (or e-Transfer name,
// email, alias…), Enter to open them. Pages are listed too.

type Item = { kind: 'member'; member: MemberSummary } | { kind: 'page'; to: string; label: string; icon: (typeof NAV_ITEMS)[number]['icon'] };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [q, setQ] = React.useState('');
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const restoreFocus = React.useRef<HTMLElement | null>(null);
  const query = useDebounced(q.trim(), 120);

  const members = useQuery({
    queryKey: queryKeys.memberList({ palette: true, q: query }),
    queryFn: () => api.members({ q: query || undefined, status: query ? 'all' : 'current', sort: 'name', dir: 'asc', page: 1, pageSize: 8 }),
    enabled: open,
    staleTime: 10_000,
  });

  const items: Item[] = React.useMemo(() => {
    const pages = NAV_ITEMS.filter((p) => !query || fold(p.label).includes(fold(query))).map<Item>((p) => ({ kind: 'page', to: p.to, label: p.label, icon: p.icon }));
    const people = (members.data?.items ?? []).map<Item>((m) => ({ kind: 'member', member: m }));
    return query ? [...people, ...pages] : [...pages.slice(0, 4), ...people];
  }, [members.data, query]);

  React.useEffect(() => setActive(0), [query]);
  React.useEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      setQ('');
      setTimeout(() => inputRef.current?.focus(), 0);
    } else restoreFocus.current?.focus?.();
  }, [open]);

  if (!open) return null;

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onOpenChange(false);
    navigate(item.kind === 'member' ? `/members/${item.member.id}` : item.to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onOpenChange(false);
    }
  };

  const listId = 'command-palette-list';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Jump to a member or page">
      <div className="absolute inset-0 bg-black/60" onClick={() => onOpenChange(false)} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg border bg-card text-card-foreground shadow-2xl" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a member by name, e-Transfer name or email…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items[active] ? `cp-item-${active}` : undefined}
            aria-label="Search"
          />
          <kbd className="hidden rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground sm:inline">Esc</kbd>
        </div>
        <ul id={listId} role="listbox" className="max-h-80 overflow-y-auto p-1">
          {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">{members.isFetching ? 'Searching…' : 'No member or page matches.'}</li>}
          {items.map((item, i) => (
            <li
              key={item.kind === 'member' ? `m${item.member.id}` : `p${item.to}`}
              id={`cp-item-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(item)}
              className={cn('flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm', i === active && 'bg-accent text-accent-foreground')}
            >
              {item.kind === 'member' ? (
                <>
                  <User className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {item.member.displayName}
                    {item.member.etransferName && item.member.etransferName !== item.member.displayName && <span className="text-muted-foreground"> · {item.member.etransferName}</span>}
                  </span>
                  <StatusBadge status={item.member.status} />
                </>
              ) : (
                <>
                  <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{item.label}</span>
                  <span className="text-xs text-muted-foreground">Page</span>
                </>
              )}
              {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Global Ctrl/⌘-K listener. */
export function useCommandPaletteShortcut(setOpen: React.Dispatch<React.SetStateAction<boolean>>) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
}
