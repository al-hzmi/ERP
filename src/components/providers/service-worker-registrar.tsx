'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker, and only where it should be registered.
 *
 * Skipped in development: a worker caching the dev server's output produces stale
 * modules and hot-reload failures that look like application bugs, and the hour lost to
 * diagnosing that is a well-known tax on adding a worker to a Next.js project.
 *
 * Renders nothing. It is a component rather than a bare module import because
 * registration must run in the browser after hydration, and a module-level side effect
 * would also run during the server render.
 */
export function ServiceWorkerRegistrar(): null {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    const register = (): void => {
      void navigator.serviceWorker.register('/service-worker.js').catch(() => {
        // Offline mode is an enhancement. A browser that refuses the registration —
        // private mode, a policy, an unsupported context — should get an application
        // that works online rather than an error it cannot act on.
      });
    };

    // Registration competes with the initial render for bandwidth and main-thread time.
    // Deferring it to `load` keeps first paint the priority.
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}
