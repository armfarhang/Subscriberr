import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

/** Search box + result buttons for choosing a member (Review Queue, import review, rules). */
export function MemberPicker({ onPick, extra, placeholder = 'Search members by name or email…' }: { onPick: (id: number, name: string) => void; extra?: React.ReactNode; placeholder?: string }) {
  const [q, setQ] = React.useState('');
  const query = { q, status: 'all' as const, pageSize: 8 };
  const results = useQuery({ queryKey: queryKeys.memberList(query), queryFn: () => api.members(query), enabled: q.trim().length > 0 });
  return (
    <div className="w-full space-y-2 rounded-md border bg-card p-2">
      <Input autoFocus placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search members" />
      <div className="flex flex-wrap gap-1.5">
        {extra}
        {results.data?.items.map((m) => (
          <Button key={m.id} type="button" size="sm" variant="secondary" onClick={() => onPick(m.id, m.displayName)}>
            {m.displayName}
            {m.email && <span className="text-muted-foreground">· {m.email}</span>}
          </Button>
        ))}
        {results.data && results.data.items.length === 0 && <span className="text-xs text-muted-foreground">No member matches.</span>}
      </div>
    </div>
  );
}
