import { execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID, verify as cryptoVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';
import { unwrap } from '@/lib/domain/shared/result';
import {
  buildSignedInfo,
  buildSignedProperties,
  hexToBase64,
  parseCertificate,
  parseQrPayload,
  sha256Hex,
  stripPemArmour,
} from '@/lib/domain/zatca/zatca-crypto';
import { generateZatcaInvoice } from '@/lib/application/services/zatca-service';
import {
  getZatcaConfig,
  saveZatcaConfig,
} from '@/lib/application/services/zatca-config-service';
import {
  describeQrPayload,
  getComplianceSummary,
} from '@/lib/application/services/zatca-submission-service';
import { withTransaction } from '@/lib/infrastructure/db/prisma';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';

/**
 * ZATCA Phase 2 against a real database.
 *
 * ## What each block is actually protecting
 *
 * **The counter.** ICV must be gap-free and unique per tenant, because ZATCA reads a gap as an
 * invoice that was issued and then hidden. The obvious implementation — `count(*) + 1` — is
 * correct in every single-threaded test and wrong under concurrency, so there is a test that
 * posts invoices concurrently and asserts the counters are distinct and contiguous.
 *
 * **The chain.** Each invoice's `previousHash` must be its predecessor's `invoiceHash`, walking
 * back to the genesis value. A fork invalidates every invoice after it.
 *
 * **The digest boundary.** The stored hash must be the digest of the *unsigned* invoice, even
 * though the stored XML contains the signature. Getting this backwards produces a chain that
 * looks perfect and signatures no verifier will accept — which is why it is asserted directly
 * rather than inferred.
 *
 * **The secret boundary.** `getZatcaConfig` is what the settings screen reads. Nothing it
 * returns may contain the private key or the CSID secret, in any form.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

const workdir = mkdtempSync(join(tmpdir(), 'zatca-it-'));

/** A self-signed P-256 certificate standing in for a CSID, which ZATCA alone can issue. */
function issueCertificate(): { certificate: string; privateKey: string } {
  const keyPath = join(workdir, 'key.pem');
  const certPath = join(workdir, 'cert.pem');

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec',
    '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', certPath,
    '-days', '365', '-nodes',
    '-subj', '/C=SA/O=Al-Ufuq/CN=TST-886431145-399999999900003',
  ]);

  return {
    certificate: readFileSync(certPath, 'utf8'),
    privateKey: readFileSync(keyPath, 'utf8'),
  };
}

const credentials = issueCertificate();

let tenantId = '';
let userId = '';
let branchId = '';
let customerId = '';
let documentSequence = 0;

function audit() {
  return {
    tenantId,
    userId,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    correlationId: randomUUID(),
  };
}

/** A posted sales invoice, and the e-invoice envelope generated for it. */
async function postInvoice(
  buyerVatNumber: string | null = null,
): Promise<Awaited<ReturnType<typeof generateZatcaInvoice>>> {
  documentSequence += 1;
  const documentNumber = `INV-${String(documentSequence).padStart(5, '0')}`;

  const document = await prisma.document.create({
    data: {
      tenantId,
      documentNumber,
      type: 'SALES_INVOICE',
      status: 'POSTED',
      counterpartyId: customerId,
      branchId,
      issueDate: new Date('2026-03-15T00:00:00.000Z'),
      dueDate: new Date('2026-04-15T00:00:00.000Z'),
      subtotal: '1000.0000',
      taxTotal: '150.0000',
      total: '1150.0000',
      createdById: userId,
    },
    select: { id: true },
  });

  return runInTenantScope({ tenantId }, () =>
    withTransaction(async (tx) =>
      generateZatcaInvoice(tx, {
        tenantId,
        documentId: document.id,
        documentNumber,
        issueDate: new Date('2026-03-15T00:00:00.000Z'),
        sellerNameAr: 'شركة الأفق المتحدة للتجارة',
        sellerVatNumber: '300000000000003',
        buyerNameAr: 'عميل نقدي',
        buyerVatNumber,
        totalWithVat: Money.of('1150.00', 'SAR'),
        vatTotal: Money.of('150.00', 'SAR'),
        currency: 'SAR',
        lines: [
          {
            nameAr: 'صنف تجريبي',
            quantity: Quantity.of('2'),
            unitPrice: Money.of('500.00', 'SAR'),
            taxRate: '15.00',
            lineTotal: Money.of('1150.00', 'SAR'),
          },
        ],
      }),
    ),
  );
}

async function onboard(isActive = true): Promise<void> {
  const result = await runInTenantScope({ tenantId }, () =>
    saveZatcaConfig({
      tenantId,
      audit: audit(),
      environment: 'SANDBOX',
      sellerVatNumber: '300000000000003',
      sellerNameAr: 'شركة الأفق المتحدة للتجارة',
      csidCertificate: credentials.certificate,
      csidSecret: 'super-secret-value',
      privateKey: credentials.privateKey,
      isActive,
    }),
  );

  expect(result.ok).toBe(true);
}

afterAll(async () => {
  rmSync(workdir, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('ZATCA Phase 2', () => {
  beforeEach(async () => {
    documentSequence = 0;
    const code = `ZTC_${randomUUID().slice(0, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { code, nameAr: 'زاتكا', nameEn: 'Zatca' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: {
        tenantId,
        username: 'clerk',
        email: `clerk@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'محاسب',
        fullNameEn: 'Clerk',
      },
      select: { id: true },
    });
    userId = user.id;

    const branch = await prisma.branch.create({
      data: { tenantId, code: 'BR1', nameAr: 'الفرع', nameEn: 'Branch' },
      select: { id: true },
    });
    branchId = branch.id;

    const customer = await prisma.counterparty.create({
      data: { tenantId, code: 'C1', type: 'CUSTOMER', nameAr: 'عميل', nameEn: 'Customer' },
      select: { id: true },
    });
    customerId = customer.id;
  });

  describe('the invoice counter', () => {
    it('starts at 1 and increments without gaps', async () => {
      const first = unwrap(await postInvoice());
      const second = unwrap(await postInvoice());
      const third = unwrap(await postInvoice());

      expect([first.icv, second.icv, third.icv]).toEqual([1n, 2n, 3n]);
    });

    it('stays gap-free and unique when invoices are posted concurrently', async () => {
      // `count(*) + 1` passes every sequential test and fails this one: two transactions read
      // the same count and compute the same next value. `erp_next_document_number` holds a row
      // lock, so they serialise on it instead.
      const results = await Promise.all([
        postInvoice(),
        postInvoice(),
        postInvoice(),
        postInvoice(),
        postInvoice(),
      ]);

      const counters = results.map((result) => unwrap(result).icv).sort((a, b) => Number(a - b));

      expect(counters).toEqual([1n, 2n, 3n, 4n, 5n]);
      expect(new Set(counters).size).toBe(5);
    });

    it('is written into the XML, so the signature commits to it', async () => {
      const result = unwrap(await postInvoice());

      expect(result.xml).toContain('<cbc:ID>ICV</cbc:ID>');
      expect(result.xml).toContain(`<cbc:UUID>${result.icv.toString()}</cbc:UUID>`);
    });

    it('does not restart when a new calendar year begins', async () => {
      // ICV is stored under the sentinel year 0 precisely so that it does not roll over the
      // way `INV-2026-00001` does. A reset would read to ZATCA as a suppressed invoice run.
      await postInvoice();
      await postInvoice();

      const sequences = await prisma.numberSequence.findMany({
        where: { tenantId, key: 'ZATCA_ICV' },
        select: { year: true, nextValue: true },
      });

      expect(sequences).toHaveLength(1);
      expect(sequences[0]?.year).toBe(0);
      expect(sequences[0]?.nextValue).toBe(3n);
    });
  });

  describe('the hash chain', () => {
    it('links each invoice to its predecessor, back to the genesis hash', async () => {
      const genesis = '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9';

      const first = unwrap(await postInvoice());
      const second = unwrap(await postInvoice());
      const third = unwrap(await postInvoice());

      expect(first.previousHash).toBe(genesis);
      expect(second.previousHash).toBe(first.invoiceHash);
      expect(third.previousHash).toBe(second.invoiceHash);
    });

    it('embeds the predecessor hash as Base64, not hex', async () => {
      const first = unwrap(await postInvoice());
      const second = unwrap(await postInvoice());

      expect(second.xml).toContain(hexToBase64(first.invoiceHash));
      expect(second.xml).not.toContain(first.invoiceHash);
    });
  });

  describe('signing', () => {
    it('posts an unsigned but complete envelope when the tenant has not onboarded', async () => {
      // The ordinary case for a system in its first week. Refusing to post would stop the
      // business trading; pretending it is signed would be a lie in a legal document.
      const result = unwrap(await postInvoice());

      expect(result.signed).toBe(false);
      expect(result.xml).not.toContain('ds:SignatureValue');
      expect(parseQrPayload(result.qrCode).map((field) => field.tag)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('leaves invoices unsigned while the config exists but is not active', async () => {
      await onboard(false);
      const result = unwrap(await postInvoice());

      expect(result.signed).toBe(false);
    });

    it('signs once the CSID is installed and active', async () => {
      await onboard();
      const result = unwrap(await postInvoice());

      expect(result.signed).toBe(true);
      expect(result.xml).toContain('<ds:SignatureValue>');
      expect(result.xml).toContain('xadesSignedProperties');

      const tags = parseQrPayload(result.qrCode).map((field) => field.tag);
      expect(tags).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('hashes the UNSIGNED invoice, even though it stores the signed one', async () => {
      await onboard();
      const result = unwrap(await postInvoice());

      // The stored XML contains the signature; the stored hash must not. Digesting the
      // assembled document would produce a chain that looks perfect and a signature that
      // covers a digest of itself.
      expect(result.xml).toContain('<ds:SignatureValue>');
      expect(sha256Hex(result.xml)).not.toBe(result.invoiceHash);

      // And the signature verifies against the certificate over exactly that digest.
      const parts = parseCertificate(credentials.certificate);
      const stored = await prisma.zatcaInvoice.findFirstOrThrow({
        where: { tenantId },
        select: { signature: true, issuedAtUtc: true, publicKey: true, certSignature: true },
      });

      const signedProperties = buildSignedProperties({
        signingTime: stored.issuedAtUtc,
        certificateDigest: parts.digest,
        issuerName: parts.issuerName,
        serialNumber: parts.serialNumber,
      });

      const signedInfo = buildSignedInfo({
        invoiceDigest: hexToBase64(result.invoiceHash),
        signedPropertiesDigest: Buffer.from(sha256Hex(signedProperties), 'hex').toString('base64'),
      });

      expect(
        cryptoVerify(
          'sha256',
          Buffer.from(signedInfo, 'utf8'),
          { key: createPublicKey(credentials.certificate), dsaEncoding: 'der' },
          Buffer.from(stored.signature ?? '', 'base64'),
        ),
      ).toBe(true);

      expect(stored.publicKey).toBe(parts.publicKeyDer.toString('base64'));
      expect(stored.certSignature).toBe(parts.issuerSignature.toString('base64'));
    });

    it('classifies a buyer with a VAT number as STANDARD, and clears rather than reports', async () => {
      await onboard();

      const consumer = unwrap(await postInvoice(null));
      const business = unwrap(await postInvoice('310000000000003'));

      expect(consumer.invoiceTypeCode).toBe('SIMPLIFIED');
      expect(business.invoiceTypeCode).toBe('STANDARD');
    });
  });

  describe('the secret boundary', () => {
    it('never returns the private key or the secret from the settings read', async () => {
      await onboard();

      const config = await runInTenantScope({ tenantId }, () => getZatcaConfig(tenantId));
      const serialised = JSON.stringify(config);

      expect(config?.hasPrivateKey).toBe(true);
      expect(config?.hasSecret).toBe(true);

      // Not "does not contain the key field" — does not contain the key, anywhere, in any
      // shape. A settings screen that round-trips it has put it in a browser cache and a
      // proxy log.
      expect(serialised).not.toContain('BEGIN');
      expect(serialised).not.toContain('super-secret-value');
      expect(serialised).not.toContain(stripPemArmour(credentials.privateKey).slice(0, 40));
    });

    it('stores the private key encrypted, not as plaintext', async () => {
      await onboard();

      const row = await prisma.zatcaConfig.findUniqueOrThrow({
        where: { tenantId },
        select: { privateKeyEnc: true, csidSecretEnc: true, csidCertificate: true },
      });

      // `v1.<iv>.<tag>.<ciphertext>` — the envelope `encryptField` writes.
      expect(row.privateKeyEnc).toMatch(/^v1\./);
      expect(row.privateKeyEnc).not.toContain('BEGIN');
      expect(row.csidSecretEnc).toMatch(/^v1\./);
      expect(row.csidSecretEnc).not.toContain('super-secret-value');

      // The certificate is deliberately NOT encrypted: it is a public document, it is embedded
      // in every invoice, and encrypting it would only make it unreadable to the settings
      // screen for no gain.
      expect(row.csidCertificate).toContain('BEGIN CERTIFICATE');
    });

    it('treats a blank credential field as "keep", never as "clear"', async () => {
      await onboard();

      // Loading the settings page and pressing save must not de-onboard the tenant.
      const result = await runInTenantScope({ tenantId }, () =>
        saveZatcaConfig({
          tenantId,
          audit: audit(),
          environment: 'SIMULATION',
          sellerVatNumber: '300000000000003',
          sellerNameAr: 'الاسم بعد التعديل',
          csidCertificate: '',
          csidSecret: '',
          privateKey: '',
          isActive: true,
        }),
      );

      expect(result.ok).toBe(true);

      const config = await runInTenantScope({ tenantId }, () => getZatcaConfig(tenantId));
      expect(config?.hasPrivateKey).toBe(true);
      expect(config?.hasCertificate).toBe(true);
      expect(config?.environment).toBe('SIMULATION');
      expect(config?.sellerNameAr).toBe('الاسم بعد التعديل');
    });

    it('refuses activation without a key, in a sentence rather than a constraint name', async () => {
      const result = await runInTenantScope({ tenantId }, () =>
        saveZatcaConfig({
          tenantId,
          audit: audit(),
          environment: 'SANDBOX',
          sellerVatNumber: '300000000000003',
          sellerNameAr: 'منشأة',
          isActive: true,
        }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.messageAr).toContain('شهادة CSID');
      }
    });

    it('refuses a malformed VAT number before it reaches the CHECK constraint', async () => {
      for (const vatNumber of ['123', '400000000000003', '300000000000004']) {
        const result = await runInTenantScope({ tenantId }, () =>
          saveZatcaConfig({
            tenantId,
            audit: audit(),
            environment: 'SANDBOX',
            sellerVatNumber: vatNumber,
            sellerNameAr: 'منشأة',
            isActive: false,
          }),
        );

        expect(result.ok).toBe(false);
      }
    });

    it('refuses a certificate that cannot be parsed, at save time rather than posting time', async () => {
      const result = await runInTenantScope({ tenantId }, () =>
        saveZatcaConfig({
          tenantId,
          audit: audit(),
          environment: 'SANDBOX',
          sellerVatNumber: '300000000000003',
          sellerNameAr: 'منشأة',
          csidCertificate: 'bm90IGEgY2VydGlmaWNhdGU=',
          isActive: false,
        }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.messageAr).toContain('CSID');
      }
    });

    it('writes an audit entry that records the change without recording the secret', async () => {
      await onboard();

      const entries = await prisma.auditLog.findMany({
        where: { tenantId, entityType: 'zatcaConfig' },
        select: { metadata: true },
      });

      expect(entries.length).toBeGreaterThan(0);
      const serialised = JSON.stringify(entries);
      expect(serialised).toContain('privateKeyReplaced');
      expect(serialised).not.toContain('super-secret-value');
      expect(serialised).not.toContain('BEGIN');
    });
  });

  describe('the compliance summary', () => {
    it('counts what is pending, what is unsigned, and where the counter stands', async () => {
      await postInvoice();
      await postInvoice();
      await onboard();
      await postInvoice();

      const summary = await runInTenantScope({ tenantId }, () => getComplianceSummary(tenantId));

      expect(summary.total).toBe(3);
      expect(summary.pending).toBe(3);
      expect(summary.unsigned).toBe(2);
      expect(summary.latestIcv).toBe(3n);
      expect(summary.failed).toBe(0);
    });

    it('describes the QR in words, with the binary tags shown as byte counts', async () => {
      await onboard();
      const result = unwrap(await postInvoice());

      const described = describeQrPayload(result.qrCode);

      expect(described).toHaveLength(9);
      expect(described[0]?.value).toBe('شركة الأفق المتحدة للتجارة');
      expect(described[1]?.value).toBe('300000000000003');
      expect(described[5]?.value).toBe(hexToBase64(result.invoiceHash));
      // Rendering DER as text produces mojibake and implies the data is broken when it is fine.
      expect(described[6]?.value).toMatch(/بايت/);
      expect(described[8]?.value).toMatch(/بايت/);
    });
  });
});
