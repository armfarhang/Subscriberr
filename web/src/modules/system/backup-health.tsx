import type { Me, SystemStatus } from '@subscriberr/shared';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatAge, formatBytes, formatDateTime } from '@/lib/format';

/** Loud banner when backups are not safe: stale/missing backup or a bad destination (Spec §6.9). */
export function BackupWarnings({ status }: { status: SystemStatus }) {
  const problems = [...status.backupDestination.problems];
  if (status.backupStale) {
    problems.unshift(
      status.lastBackupOkAt
        ? `The newest verified backup is ${formatAge(status.lastBackupOkAt)} (older than 36 hours).`
        : 'No verified backup exists yet. Use "Back up now" on the System page, or wait for the nightly backup at 03:00.',
    );
  }
  if (problems.length === 0) return null;
  return (
    <div role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
      <div className="mb-1 flex items-center gap-2 font-semibold text-warning">
        <AlertTriangle className="h-4 w-4" aria-hidden /> Backups need attention
      </div>
      <ul className="list-disc space-y-1 pl-5 text-foreground/90">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

export function BackupSummary({ status, me }: { status: SystemStatus; me: Me }) {
  const dest = status.backupDestination;
  const rows: Array<[string, string]> = [
    ['Last verified backup', status.lastBackupOkAt ? `${formatDateTime(status.lastBackupOkAt, me.timezone)} (${formatAge(status.lastBackupOkAt)})` : 'never'],
    ['Destination', dest.path],
    ['Free space', formatBytes(dest.freeBytes)],
    ['Separate disk from data', dest.exists ? (dest.sameFilesystemAsData ? 'No — same filesystem' : 'Yes') : 'Unknown'],
  ];
  const healthy = dest.ok && !status.backupStale;
  return (
    <div className="space-y-3">
      <div className={`flex items-center gap-2 text-sm font-medium ${healthy ? 'text-success' : 'text-warning'}`}>
        {healthy ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <AlertTriangle className="h-4 w-4" aria-hidden />}
        {healthy ? 'Backups are healthy' : 'Backups need attention'}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
