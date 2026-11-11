import * as React from 'react';
import { cn } from '@/lib/utils';

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export const Card = ({ className, ...props }: DivProps) => (
  <div className={cn('rounded-lg border bg-card text-card-foreground shadow-sm', className)} {...props} />
);
export const CardHeader = ({ className, ...props }: DivProps) => <div className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
export const CardTitle = ({ className, ...props }: DivProps) => <div className={cn('text-sm font-semibold leading-none tracking-tight', className)} {...props} />;
export const CardDescription = ({ className, ...props }: DivProps) => <div className={cn('text-sm text-muted-foreground', className)} {...props} />;
export const CardContent = ({ className, ...props }: DivProps) => <div className={cn('p-5 pt-0', className)} {...props} />;
