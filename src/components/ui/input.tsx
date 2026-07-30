import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /**
   * Renders the value in the tabular-numeral face and isolates its direction.
   *
   * An amount typed into an RTL document is a left-to-right run inside a
   * right-to-left paragraph, and without isolation the bidirectional algorithm
   * reorders the minus sign and any trailing punctuation. Proportional digits also
   * make a column of figures impossible to scan, which is most of what an
   * accountant does with one.
   */
  numeric?: boolean;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, numeric = false, invalid = false, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      dir={numeric ? 'ltr' : undefined}
      className={cn(
        'h-10 w-full rounded-md border bg-background px-3 text-sm',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        numeric && 'numeric text-end tabular-nums',
        invalid ? 'border-destructive' : 'border-input',
        className,
      )}
      {...props}
    />
  );
});
