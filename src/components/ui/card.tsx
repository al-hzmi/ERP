import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <section className={cn('card-surface', className)}>{children}</section>;
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold">{title}</h2>
        {description !== undefined ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action !== undefined ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}
