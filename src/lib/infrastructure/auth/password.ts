import bcrypt from 'bcryptjs';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';

/**
 * Password hashing and policy.
 *
 * bcrypt at cost 12 — roughly 250 ms per hash on current hardware, which is
 * slow enough to make offline cracking expensive and fast enough that a login
 * still feels instant. The cost is stored inside the hash, so raising it later
 * only affects new and re-hashed passwords.
 */

const BCRYPT_COST = 12;

/** Length caps matter: bcrypt silently truncates beyond 72 bytes. */
const MIN_LENGTH = 12;
const MAX_LENGTH = 72;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Verifies a password.
 *
 * bcrypt's comparison is constant-time with respect to the hash, so this does
 * not leak how much of a password was correct.
 */
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash
    // that distinguishes this account from every other one.
    return false;
  }
}

/** True when a stored hash was produced at a lower cost and should be upgraded on next login. */
export function needsRehash(hash: string): boolean {
  const match = /^\$2[aby]\$(\d{2})\$/.exec(hash);
  if (match === null) return true;
  const cost = Number.parseInt(match[1] ?? '0', 10);
  return cost < BCRYPT_COST;
}

/**
 * A password policy that resists real attacks rather than merely looking strict.
 *
 * Length carries most of the weight; the composition rules exist because
 * regulators ask for them. The blocklist catches the handful of passwords that
 * satisfy every rule and are still tried first by every credential-stuffing tool.
 */
const COMMON_PASSWORDS = new Set([
  'password123456',
  'qwerty123456789',
  'administrator1',
  '123456789012',
  'passw0rd!2024',
  'welcome12345',
  'letmein123456',
]);

export function validatePasswordStrength(
  password: string,
  context: { username?: string; email?: string } = {},
): Result<void, DomainError> {
  if (password.length < MIN_LENGTH) {
    return err(
      DomainErrors.validation(
        `كلمة المرور يجب أن تكون ${MIN_LENGTH} حرفاً على الأقل.`,
        `The password must be at least ${MIN_LENGTH} characters long.`,
        'password',
      ),
    );
  }

  if (Buffer.byteLength(password, 'utf8') > MAX_LENGTH) {
    return err(
      DomainErrors.validation(
        `كلمة المرور طويلة جداً (الحد الأقصى ${MAX_LENGTH} بايت).`,
        `The password is too long (maximum ${MAX_LENGTH} bytes).`,
        'password',
      ),
    );
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;

  if (classes < 3) {
    return err(
      DomainErrors.validation(
        'كلمة المرور يجب أن تحتوي على ثلاثة أنواع على الأقل من: حروف صغيرة، حروف كبيرة، أرقام، رموز.',
        'The password must contain at least three of: lowercase, uppercase, digits, symbols.',
        'password',
      ),
    );
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return err(
      DomainErrors.validation(
        'كلمة المرور هذه شائعة جداً ويسهل تخمينها.',
        'This password is too common and easily guessed.',
        'password',
      ),
    );
  }

  const identifiers = [context.username, context.email?.split('@')[0]].filter(
    (value): value is string => value !== undefined && value.length >= 3,
  );

  for (const identifier of identifiers) {
    if (password.toLowerCase().includes(identifier.toLowerCase())) {
      return err(
        DomainErrors.validation(
          'كلمة المرور يجب ألا تحتوي على اسم المستخدم أو البريد الإلكتروني.',
          'The password must not contain your username or email address.',
          'password',
        ),
      );
    }
  }

  return ok();
}

/**
 * Account lockout schedule.
 *
 * Escalating rather than fixed: a user who fat-fingers their password three
 * times is barely inconvenienced, while an automated attack is throttled to
 * uselessness within a dozen attempts.
 */
export function lockoutDurationSeconds(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  if (failedAttempts < 8) return 60;
  if (failedAttempts < 12) return 15 * 60;
  return 60 * 60;
}
