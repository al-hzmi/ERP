import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: readonly SelectOption[];
  /** Shown as a disabled first entry, so "nothing chosen" is a visible state. */
  placeholder?: string;
  invalid?: boolean;
}

/**
 * A native `<select>`, deliberately.
 *
 * A custom listbox would need keyboard navigation, type-ahead, screen-reader
 * semantics and a mobile story that all already exist here for free — and on a
 * phone the platform picker beats anything reimplemented in a div. The searchable
 * pickers in this app are the ones over thousands of rows (products,
 * counterparties); a branch list is eight entries and does not need one.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, invalid = false, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-10 w-full rounded-md border bg-background px-3 text-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        invalid ? 'border-destructive' : 'border-input',
        className,
      )}
      {...props}
    >
      {placeholder !== undefined ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
});
