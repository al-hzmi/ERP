import type { BadgeTone } from '@/components/ui/badge';

/**
 * ZATCA status vocabulary, in a module a client component may import.
 *
 * It lives apart from the services on purpose. Importing a *value* from
 * `zatca-submission-service` into a `'use client'` file drags in `prisma.ts`, which imports
 * `node:async_hooks`, which webpack cannot bundle for the browser — the build fails with an
 * `UnhandledSchemeError` that names neither file. The labels are pure data, so they belong
 * where both sides can reach them.
 */

export type ZatcaStatus =
  | 'PENDING'
  | 'REPORTED'
  | 'CLEARED'
  | 'ACCEPTED_WITH_WARNINGS'
  | 'FAILED';

export interface StatusPresentation {
  readonly label: string;
  readonly tone: BadgeTone;
  /** One line explaining what the state means for the business, not what it means technically. */
  readonly meaning: string;
}

export const ZATCA_STATUS: Record<ZatcaStatus, StatusPresentation> = {
  PENDING: {
    label: 'بانتظار الإرسال',
    tone: 'neutral',
    meaning: 'أُنشئت الفاتورة الإلكترونية ولم تُرسل بعد إلى الهيئة.',
  },
  REPORTED: {
    label: 'مُبلَّغ عنها',
    tone: 'success',
    meaning: 'فاتورة مبسَّطة (B2C) استلمتها الهيئة خلال مهلة الأربع والعشرين ساعة.',
  },
  CLEARED: {
    label: 'معتمدة',
    tone: 'success',
    meaning: 'فاتورة ضريبية (B2B) اعتمدتها الهيئة قبل تسليمها للعميل.',
  },
  ACCEPTED_WITH_WARNINGS: {
    label: 'مقبولة بملاحظات',
    tone: 'warning',
    meaning: 'قبِلتها الهيئة مع ملاحظات يجب معالجتها قبل الفواتير القادمة.',
  },
  FAILED: {
    label: 'مرفوضة',
    tone: 'danger',
    meaning: 'رفضتها الهيئة. التفاصيل في سجل الاستجابة، ويلزم تصحيحها وإعادة الإرسال.',
  },
};

export const ZATCA_ENVIRONMENT_LABELS: Record<string, string> = {
  SANDBOX: 'بيئة التطوير (Sandbox)',
  SIMULATION: 'بيئة المحاكاة (Simulation)',
  PRODUCTION: 'بيئة الإنتاج (Production)',
};

export const INVOICE_TYPE_LABELS: Record<string, string> = {
  STANDARD: 'فاتورة ضريبية (B2B) — اعتماد',
  SIMPLIFIED: 'فاتورة مبسَّطة (B2C) — إبلاغ',
};
