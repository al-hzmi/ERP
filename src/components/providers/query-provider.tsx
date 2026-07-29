'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * Server-state provider.
 *
 * The client is created inside `useState` rather than at module scope: a
 * module-level client is shared across every request on the server, which leaks
 * one user's cached data into another user's render.
 */
export function QueryProvider({ children }: { children: ReactNode }): JSX.Element {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Financial data goes stale the moment someone else posts something,
            // but refetching on every window focus makes a data-entry screen
            // flicker while the user is typing. Thirty seconds is the compromise.
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // A 4xx will fail identically however many times it is retried;
              // only transient failures are worth another attempt.
              const status = (error as { status?: number }).status;
              if (status !== undefined && status >= 400 && status < 500) return false;
              return failureCount < 3;
            },
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
          },
          mutations: {
            // Mutations are never retried automatically: re-sending "post this
            // invoice" after a timeout is how an invoice gets posted twice.
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
