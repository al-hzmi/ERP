import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkCompliance,
  clearInvoice,
  reportInvoice,
  resetZatcaTransport,
  setZatcaTransport,
  zatcaBaseUrl,
} from '@/lib/infrastructure/zatca/zatca-client';

/**
 * The ZATCA API client, without ZATCA.
 *
 * Every branch here is a failure branch, because failure is the normal case for a government
 * gateway and the caller has to persist *something* either way. The two that matter most:
 *
 *   - a 400 must not be retried. ZATCA has read the invoice and refused it; sending identical
 *     bytes again produces an identical refusal and burns the submission window.
 *   - a 403 with a body ZATCA did not write is a proxy, not a credential problem. Telling the
 *     operator their certificate is wrong sends them to replace a certificate that is fine.
 */

const credentials = {
  environment: 'SANDBOX' as const,
  certificateBase64: 'Q1NJRA==',
  secret: 'sekret',
};

const payload = {
  invoiceUuid: '00000000-0000-4000-8000-000000000001',
  invoiceHashHex: 'ab'.repeat(32),
  invoiceBase64: 'PEludm9pY2UvPg==',
};

function respond(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  });
}

afterEach(() => {
  resetZatcaTransport();
  vi.restoreAllMocks();
});

describe('endpoints and environments', () => {
  it('addresses a different host per tier', () => {
    expect(zatcaBaseUrl('SANDBOX')).toContain('developer-portal');
    expect(zatcaBaseUrl('SIMULATION')).toContain('simulation');
    expect(zatcaBaseUrl('PRODUCTION')).toContain('core');
    // Simulation is a distinct host, not a flag: onboarding requires passing its checks before
    // production credentials exist.
    expect(new Set(['SANDBOX', 'SIMULATION', 'PRODUCTION'].map(zatcaBaseUrl as never)).size).toBe(3);
  });

  it('clears standard invoices and reports simplified ones, at different paths', async () => {
    const urls: string[] = [];
    setZatcaTransport(async (url) => {
      urls.push(url);
      return respond(200, {});
    });

    await clearInvoice(credentials, payload);
    await reportInvoice(credentials, payload);
    await checkCompliance(credentials, payload);

    expect(urls[0]).toContain('/invoices/clearance/single');
    expect(urls[1]).toContain('/invoices/reporting/single');
    expect(urls[2]).toContain('/compliance/invoices');
  });

  it('authenticates with the CSID as the Basic username and sends the hash as Base64', async () => {
    let seen: RequestInit | null = null;
    setZatcaTransport(async (_url, init) => {
      seen = init;
      return respond(200, {});
    });

    await clearInvoice(credentials, payload);

    const headers = (seen as unknown as RequestInit).headers as Record<string, string>;
    const decoded = Buffer.from(headers['Authorization']!.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('Q1NJRA==:sekret');

    // ZATCA refuses a request without this and the error it returns does not say so.
    expect(headers['Accept-Version']).toBe('V2');
    expect(headers['Clearance-Status']).toBe('1');

    const body = JSON.parse((seen as unknown as RequestInit).body as string);
    expect(body.invoiceHash).toBe(Buffer.from(payload.invoiceHashHex, 'hex').toString('base64'));
    expect(body.invoiceHash).not.toBe(payload.invoiceHashHex);
    expect(body.uuid).toBe(payload.invoiceUuid);
  });
});

describe('interpreting the answer', () => {
  it('reads a clean 200 as accepted', async () => {
    setZatcaTransport(async () => respond(200, { clearedInvoice: 'PHN0YW1wZWQ+' }));

    const response = await clearInvoice(credentials, payload);

    expect(response.outcome).toBe('ACCEPTED');
    expect(response.clearedInvoice).toBe('PHN0YW1wZWQ+');
    expect(response.warningCount).toBe(0);
  });

  it('keeps a 202 distinct from a 200, so the warnings get read', async () => {
    setZatcaTransport(async () =>
      respond(202, {
        validationResults: { warningMessages: [{ code: 'BR-KSA-1' }, { code: 'BR-KSA-2' }] },
      }),
    );

    const response = await reportInvoice(credentials, payload);

    expect(response.outcome).toBe('ACCEPTED_WITH_WARNINGS');
    expect(response.warningCount).toBe(2);
    expect(response.messageAr).toContain('2');
  });

  it('counts warnings on a 200 too, rather than calling it clean', async () => {
    setZatcaTransport(async () =>
      respond(200, { validationResults: { warningMessages: [{ code: 'BR-KSA-9' }] } }),
    );

    expect((await clearInvoice(credentials, payload)).outcome).toBe('ACCEPTED_WITH_WARNINGS');
  });

  it('does NOT retry a 400 — ZATCA has read the invoice and refused it', async () => {
    let attempts = 0;
    setZatcaTransport(async () => {
      attempts += 1;
      return respond(400, { validationResults: { errorMessages: [{ code: 'BR-KSA-03' }] } });
    });

    const response = await clearInvoice(credentials, payload);

    expect(attempts).toBe(1);
    expect(response.outcome).toBe('REJECTED');
    expect(response.errorCount).toBe(1);
  });

  it('retries a 500 and gives up rather than looping', async () => {
    let attempts = 0;
    setZatcaTransport(async () => {
      attempts += 1;
      return respond(503, { message: 'upstream down' });
    });

    const response = await clearInvoice(credentials, payload);

    expect(attempts).toBe(3);
    expect(response.outcome).toBe('REJECTED');
  });

  it('retries a 429 rather than treating rate limiting as a rejection', async () => {
    let attempts = 0;
    setZatcaTransport(async () => {
      attempts += 1;
      return attempts < 3 ? respond(429, { message: 'slow down' }) : respond(200, {});
    });

    const response = await clearInvoice(credentials, payload);

    expect(attempts).toBe(3);
    expect(response.outcome).toBe('ACCEPTED');
  });

  it('reads a 401 with a ZATCA body as a credential problem', async () => {
    setZatcaTransport(async () => respond(401, { message: 'invalid CSID' }));

    const response = await clearInvoice(credentials, payload);

    expect(response.outcome).toBe('REJECTED');
    expect(response.messageAr).toContain('CSID');
  });

  it('reads a 403 with a body ZATCA did not write as unreachable, not as a bad certificate', async () => {
    // A corporate proxy or an egress allowlist. Telling the operator their certificate is wrong
    // sends them to replace credentials that are perfectly good.
    setZatcaTransport(async () =>
      respond(403, 'Host not in allowlist: gw-fatoora.zatca.gov.sa', 'text/plain'),
    );

    const response = await clearInvoice(credentials, payload);

    expect(response.outcome).toBe('UNREACHABLE');
    expect(response.messageAr).toContain('حُجب');
    // The gateway's text is kept verbatim, because it is the only thing that helps fix it.
    expect(JSON.stringify(response.body)).toContain('allowlist');
  });

  it('reports an unreachable gateway without pretending the invoice was refused', async () => {
    let attempts = 0;
    setZatcaTransport(async () => {
      attempts += 1;
      throw new Error('ECONNREFUSED');
    });

    const response = await clearInvoice(credentials, payload);

    expect(attempts).toBe(3);
    expect(response.outcome).toBe('UNREACHABLE');
    expect(response.httpStatus).toBeNull();
    expect(JSON.stringify(response.body)).toContain('ECONNREFUSED');
  });

  it('keeps an unparseable body instead of discarding the only diagnostic there is', async () => {
    setZatcaTransport(async () => respond(500, '<html>gateway timeout</html>', 'text/html'));

    const response = await clearInvoice(credentials, payload);

    expect(JSON.stringify(response.body)).toContain('gateway timeout');
  });

  it('survives an empty body on a success', async () => {
    setZatcaTransport(async () => new Response('', { status: 200 }));

    const response = await reportInvoice(credentials, payload);

    expect(response.outcome).toBe('ACCEPTED');
    expect(response.body).toBeNull();
  });
});
