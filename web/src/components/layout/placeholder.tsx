import { Hammer } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { NavItem } from './nav';

/** Empty state for a module whose screens are built in a later milestone. */
export function PlaceholderPage({ item }: { item: NavItem }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight lg:hidden">{item.label}</h2>
        {item.description && <p className="text-sm text-muted-foreground">{item.description}</p>}
      </div>
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <item.icon className="h-6 w-6 text-muted-foreground" aria-hidden />
          </div>
          <div className="text-base font-medium">{item.label} is not built yet</div>
          <p className="max-w-md text-sm text-muted-foreground">
            <Hammer className="mr-1 inline h-3.5 w-3.5" aria-hidden />
            This screen arrives in milestone {item.milestone}. The foundation (database, backups, demo mode and this shell) is in place.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
