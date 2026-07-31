import type { ZatcaEnvironment } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { parseCertificate, stripPemArmour, ZatcaCryptoError } from '@/lib/domain/zatca/zatca-crypto';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { decryptField, encryptField } from '@/lib/infrastructure/crypto/encryption';
import { withTenantRead, withTransaction, type TransactionClient } from '@/lib/infrastructure/db/prisma';

/**
 * The tenant's ZATCA device credentials.
 *
 * ## Nothing here ever returns a secret
 *
 * `getZatcaConfig` is what the settings screen reads, and it returns booleans where the
 * credentials are — `hasPrivateKey`, not the key. The only function that decrypts is
 * `loadSigningCredentials`, which is called by the signing path inside a transaction and
 * returns to code, not to a response body. That split is deliberate: a settings screen that
 * round-trips the private key through the browser so the user can "see it's still there" has
 * put the taxpayer's cryptographic identity into a browser cache, a proxy log and a screenshot.
 *
 * The same rule governs updates. A blank key field means "leave it alone", never "clear it" —
 * otherwise loading the settings page and pressing save silently de-onboards the tenant.
 */

export interface ZatcaConfigView {
  readonly id: string;
  readonly environment: ZatcaEnvironment;
  readonly sellerVatNumber: string;
  readonly sellerNameAr: string;
  readonly commercialRegNo: string | null;
  readonly streetName: string | null;
  readonly buildingNumber: string | null;
  readonly citySubdivision: string | null;
  readonly cityName: string | null;
  readonly postalZone: string | null;
  readonly isActive: boolean;
  readonly onboardedAt: Date | null;
  readonly hasPrivateKey: boolean;
  readonly hasCertificate: boolean;
  readonly hasSecret: boolean;
  /** Read off the certificate, so the screen can show what is actually installed. */
  readonly certificateSubject: string | null;
  readonly certificateIssuer: string | null;
  readonly certificateSerial: string | null;
  readonly certificateExpiresAt: Date | null;
  /** Set when the stored certificate cannot be parsed — a silent failure otherwise. */
  readonly certificateError: string | null;
}

/** The tenant's config, with every secret reduced to a boolean. */
export async function getZatcaConfig(tenantId: string): Promise<ZatcaConfigView | null> {
  return withTenantRead(async (tx) => {
    const config = await tx.zatcaConfig.findUnique({ where: { tenantId } });
    if (config === null) return null;

    let subject: string | null = null;
    let issuer: string | null = null;
    let serial: string | null = null;
    let expiresAt: Date | null = null;
    let certificateError: string | null = null;

    if (config.csidCertificate !== null && config.csidCertificate !== '') {
      try {
        const { X509Certificate } = await import('node:crypto');
        const x509 = new X509Certificate(Buffer.from(stripPemArmour(config.csidCertificate), 'base64'));
        subject = x509.subject.split('\n').filter(Boolean).join(', ');
        issuer = x509.issuer.split('\n').filter(Boolean).join(', ');
        serial = x509.serialNumber;
        expiresAt = new Date(x509.validTo);
      } catch (error) {
        // Surfaced rather than swallowed: a certificate that will not parse will not sign, and
        // the screen showing "installed ✓" while signing fails is the worst of both.
        certificateError = (error as Error).message;
      }
    }

    return {
      id: config.id,
      environment: config.environment,
      sellerVatNumber: config.sellerVatNumber,
      sellerNameAr: config.sellerNameAr,
      commercialRegNo: config.commercialRegNo,
      streetName: config.streetName,
      buildingNumber: config.buildingNumber,
      citySubdivision: config.citySubdivision,
      cityName: config.cityName,
      postalZone: config.postalZone,
      isActive: config.isActive,
      onboardedAt: config.onboardedAt,
      hasPrivateKey: config.privateKeyEnc !== null,
      hasCertificate: config.csidCertificate !== null,
      hasSecret: config.csidSecretEnc !== null,
      certificateSubject: subject,
      certificateIssuer: issuer,
      certificateSerial: serial,
      certificateExpiresAt: expiresAt,
      certificateError,
    };
  });
}

export interface SaveZatcaConfigInput {
  readonly tenantId: string;
  readonly audit: AuditContext;
  readonly environment: ZatcaEnvironment;
  readonly sellerVatNumber: string;
  readonly sellerNameAr: string;
  readonly commercialRegNo?: string | null;
  readonly streetName?: string | null;
  readonly buildingNumber?: string | null;
  readonly citySubdivision?: string | null;
  readonly cityName?: string | null;
  readonly postalZone?: string | null;
  /** Blank or absent means "keep what is stored". */
  readonly csidCertificate?: string | null;
  readonly csidSecret?: string | null;
  readonly privateKey?: string | null;
  readonly isActive: boolean;
}

const VAT_NUMBER = /^3[0-9]{13}3$/;

export async function saveZatcaConfig(
  input: SaveZatcaConfigInput,
): Promise<Result<{ id: string }, DomainError>> {
  const vatNumber = input.sellerVatNumber.trim();

  // Checked here as well as in the CHECK constraint. The constraint is the guarantee; this is
  // the message, and "violates constraint zatca_configs_vat_number_shape" is not one.
  if (!VAT_NUMBER.test(vatNumber)) {
    return err(
      DomainErrors.validation(
        'الرقم الضريبي يجب أن يتكوَّن من 15 رقماً يبدأ وينتهي بالرقم 3.',
        'The VAT registration number must be 15 digits beginning and ending with 3.',
        'sellerVatNumber',
      ),
    );
  }

  const certificate = blankToNull(input.csidCertificate);
  const privateKey = blankToNull(input.privateKey);
  const secret = blankToNull(input.csidSecret);

  // Parsed before it is stored. A certificate that cannot be read cannot sign, and finding
  // that out at save time costs a re-paste — finding it out at posting time costs an invoice.
  if (certificate !== null) {
    try {
      parseCertificate(certificate);
    } catch (error) {
      const message = error instanceof ZatcaCryptoError ? error.message : String(error);
      return err(
        DomainErrors.validation(
          `تعذَّرت قراءة شهادة CSID: ${message}`,
          `The CSID certificate could not be read: ${message}`,
          'csidCertificate',
        ),
      );
    }
  }

  return withTransaction(async (tx) => {
    const existing = await tx.zatcaConfig.findUnique({ where: { tenantId: input.tenantId } });

    const nextCertificate = certificate ?? existing?.csidCertificate ?? null;
    const nextPrivateKeyEnc =
      privateKey !== null ? encryptField(privateKey) : (existing?.privateKeyEnc ?? null);
    const nextSecretEnc = secret !== null ? encryptField(secret) : (existing?.csidSecretEnc ?? null);

    // Mirrors the CHECK constraint so the user gets a sentence instead of a constraint name.
    if (input.isActive && (nextCertificate === null || nextPrivateKeyEnc === null)) {
      return err(
        DomainErrors.validation(
          'لا يمكن تفعيل الفوترة الإلكترونية قبل تركيب شهادة CSID والمفتاح الخاص — التفعيل بدونهما ينتج فواتير غير موقَّعة ترفضها الهيئة بعد تسليمها للعميل.',
          'Activation requires both a CSID certificate and a private key.',
          'isActive',
        ),
      );
    }

    const data = {
      environment: input.environment,
      sellerVatNumber: vatNumber,
      sellerNameAr: input.sellerNameAr.trim(),
      commercialRegNo: blankToNull(input.commercialRegNo),
      streetName: blankToNull(input.streetName),
      buildingNumber: blankToNull(input.buildingNumber),
      citySubdivision: blankToNull(input.citySubdivision),
      cityName: blankToNull(input.cityName),
      postalZone: blankToNull(input.postalZone),
      csidCertificate: nextCertificate,
      csidSecretEnc: nextSecretEnc,
      privateKeyEnc: nextPrivateKeyEnc,
      isActive: input.isActive,
      // Stamped the first time credentials are installed, and never moved afterwards: it
      // records when this device became able to sign, which is an audit fact.
      onboardedAt:
        existing?.onboardedAt ??
        (nextCertificate !== null && nextPrivateKeyEnc !== null ? new Date() : null),
      updatedAt: new Date(),
    };

    const saved = await tx.zatcaConfig.upsert({
      where: { tenantId: input.tenantId },
      create: { tenantId: input.tenantId, ...data },
      update: data,
      select: { id: true },
    });

    await recordAudit(
      tx,
      input.audit,
      existing === null ? 'CREATE' : 'UPDATE',
      { entityType: 'zatcaConfig', entityId: saved.id },
      {
        // The audit records *that* credentials changed, never what they are. An audit log that
        // contains the private key is a second copy of the private key.
        metadata: {
          environment: input.environment,
          sellerVatNumber: vatNumber,
          isActive: input.isActive,
          certificateReplaced: certificate !== null,
          privateKeyReplaced: privateKey !== null,
          secretReplaced: secret !== null,
        },
      },
    );

    return ok(saved);
  });
}

export interface SigningCredentials {
  readonly environment: ZatcaEnvironment;
  readonly certificate: string;
  readonly privateKey: string;
  readonly secret: string | null;
  readonly sellerVatNumber: string;
  readonly sellerNameAr: string;
}

/**
 * The decrypted credentials, for the signing path only.
 *
 * Returns `null` — not an error — when the tenant has not onboarded. An un-onboarded tenant
 * issuing an invoice is the ordinary case for a system in its first month, and it must produce
 * an unsigned envelope rather than refuse the sale.
 */
export async function loadSigningCredentials(
  tx: TransactionClient,
  tenantId: string,
): Promise<SigningCredentials | null> {
  const config = await tx.zatcaConfig.findUnique({ where: { tenantId } });

  if (config === null || !config.isActive) return null;
  if (config.csidCertificate === null || config.privateKeyEnc === null) return null;

  const privateKey = decryptField(config.privateKeyEnc);
  if (privateKey === null) return null;

  return {
    environment: config.environment,
    certificate: config.csidCertificate,
    privateKey,
    secret: decryptField(config.csidSecretEnc),
    sellerVatNumber: config.sellerVatNumber,
    sellerNameAr: config.sellerNameAr,
  };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
