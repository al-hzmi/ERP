import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/styles/globals.css';

/**
 * The root layout.
 *
 * `dir="rtl"` and `lang="ar"` are set on the document element, not toggled by a
 * client-side effect. Setting direction after hydration produces a visible
 * left-to-right flash on every page load, and any server-rendered HTML in
 * between is laid out wrongly — which is precisely the failure mode of systems
 * that treat Arabic as a translation layer over an English interface.
 */

export const metadata: Metadata = {
  title: {
    default: 'نظام تخطيط موارد المؤسسة',
    template: '%s | نظام تخطيط موارد المؤسسة',
  },
  description: 'نظام محاسبي ومالي متكامل — متوافق مع المعايير الدولية وهيئة الزكاة والضريبة والجمارك',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1419' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        {/*
          The theme is applied before first paint. Reading it in a React effect
          means every dark-mode user sees a white flash on every navigation.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('erp-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.setAttribute('data-theme','dark')}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background font-sans">{children}</body>
    </html>
  );
}
