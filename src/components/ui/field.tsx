import { useId, type ReactElement, cloneElement } from 'react';
import { cn } from '@/lib/utils/cn';

export interface FieldProps {
  label: string;
  /** Marks the control required and shows the marker. */
  required?: boolean;
  /** Shown below the control until there is an error to show instead. */
  hint?: string;
  error?: string | undefined;
  className?: string;
  children: ReactElement<{
    id?: string;
    'aria-describedby'?: string;
    invalid?: boolean;
    required?: boolean;
  }>;
}

/**
 * Label, control and message, wired together.
 *
 * The wiring is the point rather than the layout. A label needs `htmlFor` pointing
 * at the control's id, and an error needs `aria-describedby` pointing back, or a
 * screen reader announces a text box with no name and no explanation of why it was
 * rejected. Both are easy to write by hand and easy to forget on the fourteenth
 * field of a form, so the id is generated here and threaded into the child.
 *
 * The error replaces the hint rather than joining it: two messages competing for
 * the same line is how a validation message goes unread.
 */
export function Field({
  label,
  required = false,
  hint,
  error,
  className,
  children,
}: FieldProps): JSX.Element {
  const id = useId();
  const messageId = `${id}-message`;
  const hasMessage = error !== undefined || hint !== undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {required ? (
          <span className="ms-1 text-destructive" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      {cloneElement(children, {
        id,
        required: required || undefined,
        invalid: error !== undefined,
        ...(hasMessage ? { 'aria-describedby': messageId } : {}),
      })}

      {hasMessage ? (
        <p
          id={messageId}
          // `role="alert"` only when there is something wrong: announcing the hint
          // interrupts the user mid-form to tell them nothing has happened.
          {...(error !== undefined ? { role: 'alert' } : {})}
          className={cn('text-xs', error !== undefined ? 'text-destructive' : 'text-muted-foreground')}
        >
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}
