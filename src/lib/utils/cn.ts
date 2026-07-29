import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, with later Tailwind utilities winning over earlier ones.
 *
 * Plain concatenation leaves both `px-2` and `px-4` in the class list and lets
 * CSS source order decide — which makes a component's `className` prop
 * unreliable exactly when a caller needs to override something.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
