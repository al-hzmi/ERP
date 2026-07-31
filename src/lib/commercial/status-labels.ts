import type { AssemblyStatus, TradeDocumentStatus } from '@prisma/client';

/**
 * Arabic labels for the commercial-document statuses.
 *
 * In their own module, away from the services that produce the rows, for a reason that is
 * structural rather than tidy: these are the only *values* a client component needs from that
 * layer, and importing a value from `trade-document-service` drags in `prisma.ts` and with it
 * `node:async_hooks`, which webpack cannot bundle for the browser. The build fails with
 * `UnhandledSchemeError` naming a module three imports away from the component that caused it.
 *
 * Type-only imports are erased and would have been fine. A label map is not a type.
 */

export const TRADE_STATUS_LABELS_AR: Record<TradeDocumentStatus, string> = {
  DRAFT: 'مسودة',
  PENDING_APPROVAL: 'بانتظار الاعتماد',
  CONFIRMED: 'مؤكَّد',
  COMPLETED: 'منفَّذ',
  CANCELLED: 'ملغى',
};

export const TRADE_STATUS_TONES: Record<
  TradeDocumentStatus,
  'neutral' | 'info' | 'success' | 'danger' | 'warning'
> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  CONFIRMED: 'info',
  COMPLETED: 'success',
  CANCELLED: 'danger',
};

export const ASSEMBLY_STATUS_LABELS_AR: Record<AssemblyStatus, string> = {
  DRAFT: 'مسودة',
  COMPLETED: 'منفَّذ',
  CANCELLED: 'ملغى',
};

export const ASSEMBLY_STATUS_TONES: Record<AssemblyStatus, 'neutral' | 'success' | 'danger'> = {
  DRAFT: 'neutral',
  COMPLETED: 'success',
  CANCELLED: 'danger',
};
