import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground ring-border',
  success: 'bg-success/10 text-success ring-success/30',
  warning: 'bg-warning/10 text-warning ring-warning/30',
  danger: 'bg-destructive/10 text-destructive ring-destructive/30',
  info: 'bg-primary/10 text-primary ring-primary/30',
};

/**
 * A status pill.
 *
 * Tone is carried by colour *and* by the text itself — colour alone fails
 * WCAG 1.4.1, and a colour-blind accountant still has to be able to tell a
 * posted invoice from a voided one.
 */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
