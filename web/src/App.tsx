import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { NAV_ITEMS } from '@/components/layout/nav';
import { PlaceholderPage } from '@/components/layout/placeholder';
import { Shell } from '@/components/layout/shell';
import { api, ApiRequestError } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { SignInPage } from '@/modules/auth/sign-in';
import { DashboardPage } from '@/modules/dashboard/dashboard-page';
import { SystemPage } from '@/modules/system/system-page';

function FullScreenMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-lg font-medium">{title}</div>
      {detail && <p className="max-w-md text-sm text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function App() {
  const config = useQuery({ queryKey: queryKeys.publicConfig, queryFn: api.publicConfig, staleTime: Infinity });
  const me = useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => {
      try {
        return await api.me();
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) return null; // not signed in
        throw err;
      }
    },
  });

  if (config.isPending || me.isPending) return <FullScreenMessage title="Loading…" />;
  if (config.isError || me.isError) {
    return <FullScreenMessage title="Cannot reach the Subscriberr server" detail={(config.error ?? me.error)?.message} />;
  }
  if (!me.data) return <SignInPage config={config.data} />;

  const account = me.data;
  return (
    <Routes>
      <Route element={<Shell me={account} config={config.data} />}>
        <Route index element={<DashboardPage me={account} />} />
        <Route path="system" element={<SystemPage me={account} />} />
        {NAV_ITEMS.filter((i) => i.milestone !== undefined).map((item) => (
          <Route key={item.to} path={`${item.to.slice(1)}/*`} element={<PlaceholderPage item={item} />} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
