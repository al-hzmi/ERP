import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans_Arabic } from 'next/font/google';
import type { ReactNode } from 'react';
import '@/styles/globals.css';

/**
 * Typography.
 *
 * IBM Plex Sans Arabic is the interface face. The choice matters more than usual
 * here: this is a dense, numeric, bilingual application, and most "Arabic web
 * fonts" are either display faces (Kufi styles, which are beautiful on a heading
 * and exhausting across a table of four hundred rows) or Latin families with
 * Arabic glyphs bolted on afterwards, which produces mismatched weights and
 * baselines the moment the two scripts sit in the same line. Plex Arabic is
 * drawn as a text face for interfaces, carries a real weight range, and shares
 * its metrics and design with the Latin family — so an Arabic customer name and
 * a Latin invoice number in the same cell look like one typeface, because they
 * are.
 *
 * IBM Plex Mono carries codes, SKUs and document numbers. Its figures are
 * tabular by construction, which is what keeps a column of amounts from
 * shifting sideways as the digits change.
 *
 * Both are loaded through `next/font`, which downloads them at build time and
 * serves them from our own origin. Nothing is requested from Google at runtime:
 * no third-party connection on every page load, no dependence on their uptime,
 * and no `font-family` that silently falls back to whatever the operating system
 * happened to have — which is exactly what was wrong before.
 */

const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-plex-arabic',
  // `swap` renders immediately in the fallback and swaps when the face arrives.
  // `block` would leave the interface invisible for up to three seconds on a
  // slow connection, which is a worse trade for an application people work in
  // all day than a brief reflow.
  display: 'swap',
  // Metric overrides on the fallback keep that reflow small: the substitute is
  // scaled to occupy roughly the same space, so text does not jump.
  adjustFontFallback: true,
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

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
    <html
      lang="ar"
      dir="rtl"
      className={`${plexArabic.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
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
