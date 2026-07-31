import type { ZatcaEnvironment } from '@prisma/client';

/**
 * The ZATCA Fatoora API client.
 *
 * Three endpoints matter:
 *
 *   `/compliance/invoices`  — onboarding. Submits sample invoices against a compliance CSID to
 *                             prove the implementation before production credentials are issued.
 *   `/invoices/clearance/single` — STANDARD (B2B). ZATCA validates *before* the invoice is
 *                             issued and returns a stamped copy. That copy is the legal invoice;
 *                             the one we generated is not.
 *   `/invoices/reporting/single` — SIMPLIFIED (B2C). Issued immediately, reported within 24
 *                             hours. ZATCA either accepts it or does not.
 *
 * ## Failure is the normal case, and it is handled here rather than at the call site
 *
 * Every response shape is mapped to one of four outcomes — accepted, accepted-with-warnings,
 * rejected, unreachable — because the caller has to persist a status either way and "the fetch
 * threw" is not a status. In particular a 400 is *not* retried: ZATCA has read the invoice and
 * refused it, and sending the identical bytes again produces the identical refusal while
 * burning the submission window.
 */

export type ZatcaOutcome = 'ACCEPTED' | 'ACCEPTED_WITH_WARNINGS' | 'REJECTED' | 'UNREACHABLE';

export interface ZatcaResponse {
  readonly outcome: ZatcaOutcome;
  readonly httpStatus: number | null;
  /** ZATCA's body verbatim, or a synthesised one when the call never landed. */
  readonly body: unknown;
  readonly warningCount: number;
  readonly errorCount: number;
  /** The cleared, ZATCA-stamped invoice, Base64. Present on a successful clearance only. */
  readonly clearedInvoice: string | null;
  /** A short line safe to show a user. Arabic — this reaches the invoice screen. */
  readonly messageAr: string;
}

/**
 * Base URLs per tier.
 *
 * `SIMULATION` is a distinct host, not a flag: onboarding requires passing its checks before
 * production credentials exist, and a client that cannot address it forces the taxpayer to edit
 * a config table halfway through onboarding.
 */
const BASE_URLS: Record<ZatcaEnvironment, string> = {
  SANDBOX: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  SIMULATION: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  PRODUCTION: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

/** ZATCA rejects a request without this, and the error it returns does not say so. */
const ACCEPT_VERSION = 'V2';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

export interface ZatcaCredentials {
  readonly environment: ZatcaEnvironment;
  /** The CSID — used as the Basic auth username. */
  readonly certificateBase64: string;
  readonly secret: string;
}

export interface SubmitInvoiceInput {
  readonly invoiceUuid: string;
  /** Hex digest of the canonical XML. Converted to Base64 on the wire. */
  readonly invoiceHashHex: string;
  /** The signed invoice XML, Base64. */
  readonly invoiceBase64: string;
}

export interface ZatcaTransport {
  (url: string, init: RequestInit): Promise<Response>;
}

/** Injected so the tests can exercise every branch without reaching ZATCA. */
let transport: ZatcaTransport = (url, init) => fetch(url, init);

export function setZatcaTransport(next: ZatcaTransport): void {
  transport = next;
}

export function resetZatcaTransport(): void {
  transport = (url, init) => fetch(url, init);
}

export function zatcaBaseUrl(environment: ZatcaEnvironment): string {
  return BASE_URLS[environment];
}

/** STANDARD (B2B). ZATCA clears before issue and returns the stamped invoice. */
export async function clearInvoice(
  credentials: ZatcaCredentials,
  input: SubmitInvoiceInput,
): Promise<ZatcaResponse> {
  return post(credentials, '/invoices/clearance/single', input, { 'Clearance-Status': '1' });
}

/** SIMPLIFIED (B2C). Reported after issue. */
export async function reportInvoice(
  credentials: ZatcaCredentials,
  input: SubmitInvoiceInput,
): Promise<ZatcaResponse> {
  return post(credentials, '/invoices/reporting/single', input, { 'Clearance-Status': '0' });
}

/** Onboarding: a sample invoice checked against the compliance CSID. */
export async function checkCompliance(
  credentials: ZatcaCredentials,
  input: SubmitInvoiceInput,
): Promise<ZatcaResponse> {
  return post(credentials, '/compliance/invoices', input, {});
}

async function post(
  credentials: ZatcaCredentials,
  path: string,
  input: SubmitInvoiceInput,
  extraHeaders: Record<string, string>,
): Promise<ZatcaResponse> {
  const url = `${zatcaBaseUrl(credentials.environment)}${path}`;

  const authorization = `Basic ${Buffer.from(
    `${credentials.certificateBase64}:${credentials.secret}`,
    'utf8',
  ).toString('base64')}`;

  const body = JSON.stringify({
    invoiceHash: Buffer.from(input.invoiceHashHex, 'hex').toString('base64'),
    uuid: input.invoiceUuid,
    invoice: input.invoiceBase64,
  });

  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await transport(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Version': ACCEPT_VERSION,
          'Accept-Language': 'ar',
          Authorization: authorization,
          ...extraHeaders,
        },
        body,
      });

      const parsed = await readBody(response);

      // 5xx and 429 are ZATCA having a bad moment; the identical request may well succeed.
      // 4xx below 429 is ZATCA having read the invoice, and retrying only wastes the window.
      if ((response.status >= 500 || response.status === 429) && attempt < MAX_ATTEMPTS) {
        lastError = `HTTP ${response.status}`;
        await backoff(attempt);
        continue;
      }

      return interpret(response.status, parsed);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    outcome: 'UNREACHABLE',
    httpStatus: null,
    body: { error: lastError, attempts: MAX_ATTEMPTS },
    warningCount: 0,
    errorCount: 0,
    clearedInvoice: null,
    messageAr: `تعذَّر الوصول إلى خوادم هيئة الزكاة والضريبة والجمارك بعد ${MAX_ATTEMPTS} محاولات. ستبقى الفاتورة بانتظار الإرسال.`,
  };
}

/** Exponential, and short: the submission window for a simplified invoice is 24 hours, but the
 *  user is watching a spinner. */
async function backoff(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 250));
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    // ZATCA returns HTML from its gateway when the request never reached the application.
    // Keeping the text is what makes that diagnosable.
    return { raw: text.slice(0, 2000) };
  }
}

interface ValidationShape {
  readonly validationResults?: {
    readonly warningMessages?: unknown[];
    readonly errorMessages?: unknown[];
  };
  readonly clearedInvoice?: string;
  readonly clearanceStatus?: string;
  readonly reportingStatus?: string;
}

function interpret(status: number, body: unknown): ZatcaResponse {
  const shaped = (body ?? {}) as ValidationShape;
  const warnings = shaped.validationResults?.warningMessages ?? [];
  const errors = shaped.validationResults?.errorMessages ?? [];

  const warningCount = Array.isArray(warnings) ? warnings.length : 0;
  const errorCount = Array.isArray(errors) ? errors.length : 0;

  const clearedInvoice = typeof shaped.clearedInvoice === 'string' ? shaped.clearedInvoice : null;

  if (status === 200 || status === 202) {
    // 202 is ZATCA's "accepted, but read these". Folding it into 200 guarantees nobody does.
    if (status === 202 || warningCount > 0) {
      return {
        outcome: 'ACCEPTED_WITH_WARNINGS',
        httpStatus: status,
        body,
        warningCount,
        errorCount,
        clearedInvoice,
        messageAr: `قُبلت الفاتورة مع ${warningCount} ملاحظة. يجب مراجعتها.`,
      };
    }

    return {
      outcome: 'ACCEPTED',
      httpStatus: status,
      body,
      warningCount: 0,
      errorCount: 0,
      clearedInvoice,
      messageAr: 'قُبلت الفاتورة لدى هيئة الزكاة والضريبة والجمارك.',
    };
  }

  if (status === 401 || status === 403) {
    // A 401/403 from ZATCA means the CSID was refused. A 401/403 whose body is not JSON did
    // not come from ZATCA at all — it is a corporate proxy, an egress allowlist or a WAF
    // between us and them. Reporting that as "your certificate is wrong" sends the operator to
    // replace credentials that are perfectly good, so the two are told apart by whether the
    // body parsed. `readBody` wraps unparseable text as `{ raw }`, which is the signal.
    const fromGateway = body !== null && typeof body === 'object' && 'raw' in body;

    if (fromGateway) {
      return {
        outcome: 'UNREACHABLE',
        httpStatus: status,
        body,
        warningCount: 0,
        errorCount: 0,
        clearedInvoice: null,
        messageAr:
          'حُجب الاتصال بخوادم الهيئة قبل أن يصل إليها (وسيط شبكة أو جدار حماية) — لم تُرفض الفاتورة. راجع إعدادات الشبكة، والتفاصيل في سجل الاستجابة.',
      };
    }

    return {
      outcome: 'REJECTED',
      httpStatus: status,
      body,
      warningCount,
      errorCount,
      clearedInvoice: null,
      messageAr:
        'رفضت الهيئة بيانات الاعتماد (CSID). يُرجى التحقق من الشهادة والمفتاح السري في إعدادات الفوترة الإلكترونية.',
    };
  }

  return {
    outcome: 'REJECTED',
    httpStatus: status,
    body,
    warningCount,
    errorCount,
    clearedInvoice: null,
    messageAr:
      errorCount > 0
        ? `رفضت الهيئة الفاتورة لوجود ${errorCount} مخالفة. التفاصيل مرفقة في سجل الاستجابة.`
        : `رفضت الهيئة الفاتورة (HTTP ${status}). التفاصيل مرفقة في سجل الاستجابة.`,
  };
}
