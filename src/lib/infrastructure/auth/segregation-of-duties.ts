import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';

/**
 * Segregation of duties.
 *
 * RBAC answers "may this user post an invoice?". SoD answers a different and
 * harder question: "may this user post *this* invoice, given that they are the
 * one who raised it?". The second is what actually stops a single employee from
 * inventing a supplier, approving the bill and paying themselves.
 *
 * The rules are expressed as conflicts between lifecycle steps on one document.
 * A conflict is evaluated against who performed each earlier step, which is why
 * `createdById`, `approvedById` and `postedById` are recorded on every document.
 */

export type LifecycleStep = 'create' | 'approve' | 'post' | 'pay' | 'void' | 'reverse';

export interface DocumentActors {
  readonly createdById: string | null;
  readonly approvedById: string | null;
  readonly postedById: string | null;
  /** Users who have recorded a payment against this document. */
  readonly paidByIds?: readonly string[];
}

interface ConflictRule {
  readonly step: LifecycleStep;
  /** Steps that, if performed by the same user, block `step`. */
  readonly conflictsWith: readonly LifecycleStep[];
  readonly reasonAr: string;
  readonly reasonEn: string;
}

/**
 * The conflict matrix.
 *
 * Deliberately asymmetric. Creating and approving is the classic fraud pair and
 * is always blocked. Creating and posting is blocked because posting is the
 * moment a document becomes financially real. Approving and posting, by
 * contrast, is *allowed*: they are both supervisory acts, and forbidding it
 * would make a two-person finance department unable to operate at all — the
 * control would be bypassed rather than followed.
 */
const CONFLICT_RULES: readonly ConflictRule[] = [
  {
    step: 'approve',
    conflictsWith: ['create'],
    reasonAr: 'لا يمكن للمستخدم الذي أنشأ المستند أن يعتمده.',
    reasonEn: 'The user who created the document cannot approve it.',
  },
  {
    step: 'post',
    conflictsWith: ['create'],
    reasonAr: 'لا يمكن للمستخدم الذي أنشأ المستند أن يرحّله.',
    reasonEn: 'The user who created the document cannot post it.',
  },
  {
    step: 'pay',
    conflictsWith: ['create', 'approve'],
    reasonAr: 'لا يمكن للمستخدم الذي أنشأ أو اعتمد المستند أن يسجل دفعته.',
    reasonEn: 'The user who created or approved the document cannot record its payment.',
  },
  {
    step: 'void',
    conflictsWith: ['create'],
    reasonAr: 'لا يمكن للمستخدم الذي أنشأ المستند أن يلغيه بمفرده.',
    reasonEn: 'The user who created the document cannot void it alone.',
  },
];

export interface SoDCheckInput {
  readonly step: LifecycleStep;
  readonly userId: string;
  readonly actors: DocumentActors;
  /** Tenants may disable enforcement; the check still runs and still reports. */
  readonly enforce: boolean;
  /**
   * A super administrator is exempt, because someone has to be able to unstick a
   * document at 2 a.m. — and because the exemption is itself audited.
   */
  readonly isSuperAdmin: boolean;
}

/**
 * Evaluates whether `userId` may perform `step` on this document.
 *
 * Returns a refusal naming the specific conflict, so the user is told what to do
 * ("ask a colleague to post this") rather than merely that they cannot.
 */
export function checkSegregationOfDuties(input: SoDCheckInput): Result<void, DomainError> {
  if (!input.enforce || input.isSuperAdmin) return ok();

  const rule = CONFLICT_RULES.find((candidate) => candidate.step === input.step);
  if (rule === undefined) return ok();

  for (const conflictingStep of rule.conflictsWith) {
    const actorId = actorForStep(input.actors, conflictingStep);
    if (actorId === null) continue;
    if (actorId !== input.userId) continue;

    return err(DomainErrors.sodViolation(rule.reasonAr, rule.reasonEn));
  }

  return ok();
}

function actorForStep(actors: DocumentActors, step: LifecycleStep): string | null {
  switch (step) {
    case 'create':
      return actors.createdById;
    case 'approve':
      return actors.approvedById;
    case 'post':
      return actors.postedById;
    case 'pay':
      return actors.paidByIds?.[0] ?? null;
    default:
      return null;
  }
}

/**
 * Detects a role assignment that would let one user hold two conflicting
 * capabilities at once.
 *
 * Run when roles are granted rather than only when a document is posted, so the
 * organisation learns about a toxic combination at configuration time instead of
 * during an audit.
 */
const TOXIC_PERMISSION_PAIRS: readonly {
  left: string;
  right: string;
  reasonAr: string;
  reasonEn: string;
}[] = [
  {
    left: 'sales.invoice:create',
    right: 'sales.invoice:post',
    reasonAr: 'إنشاء فواتير المبيعات وترحيلها',
    reasonEn: 'creating and posting sales invoices',
  },
  {
    left: 'procurement.invoice:create',
    right: 'procurement.invoice:approve',
    reasonAr: 'إنشاء فواتير المشتريات واعتمادها',
    reasonEn: 'creating and approving purchase invoices',
  },
  {
    left: 'procurement.supplier:create',
    right: 'treasury.payment:post',
    reasonAr: 'إضافة الموردين وترحيل المدفوعات',
    reasonEn: 'creating suppliers and posting payments',
  },
  {
    left: 'treasury.payment:create',
    right: 'treasury.payment:approve',
    reasonAr: 'إنشاء سندات الصرف واعتمادها',
    reasonEn: 'creating and approving payment vouchers',
  },
  {
    left: 'hr.employee:create',
    right: 'hr.payroll:post',
    reasonAr: 'إضافة الموظفين وترحيل الرواتب',
    reasonEn: 'creating employees and posting payroll',
  },
  {
    left: 'finance.journal:create',
    right: 'finance.journal:post',
    reasonAr: 'إنشاء القيود وترحيلها',
    reasonEn: 'creating and posting journal entries',
  },
];

export interface ToxicCombination {
  readonly left: string;
  readonly right: string;
  readonly messageAr: string;
  readonly messageEn: string;
}

/**
 * Reports every toxic capability pair the given permission set holds.
 *
 * Returns findings rather than blocking: a small organisation may consciously
 * accept a combination, and the right response is a documented exception with a
 * compensating control, not a system that refuses to be configured.
 */
export function findToxicCombinations(permissions: readonly string[]): ToxicCombination[] {
  const granted = new Set(permissions);

  const holds = (permission: string): boolean => {
    if (granted.has(permission)) return true;
    const [resource, action] = permission.split(':');
    return (
      granted.has(`${resource}:*`) ||
      granted.has(`*:${action}`) ||
      granted.has('*:*')
    );
  };

  return TOXIC_PERMISSION_PAIRS.filter((pair) => holds(pair.left) && holds(pair.right)).map(
    (pair) => ({
      left: pair.left,
      right: pair.right,
      messageAr: `تعارض في الفصل بين المهام: ${pair.reasonAr}.`,
      messageEn: `Segregation of duties conflict: ${pair.reasonEn}.`,
    }),
  );
}
