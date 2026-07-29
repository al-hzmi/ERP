import { describe, expect, it } from 'vitest';
import { PermissionSet, SYSTEM_ROLES } from '@/lib/infrastructure/auth/rbac';
import {
  checkSegregationOfDuties,
  findToxicCombinations,
} from '@/lib/infrastructure/auth/segregation-of-duties';
import {
  lockoutDurationSeconds,
  needsRehash,
  validatePasswordStrength,
} from '@/lib/infrastructure/auth/password';

describe('PermissionSet', () => {
  it('grants an exact permission', () => {
    const permissions = new PermissionSet(['sales.invoice:create']);
    expect(permissions.can('sales.invoice', 'create')).toBe(true);
    expect(permissions.can('sales.invoice', 'post')).toBe(false);
  });

  it('honours a resource wildcard', () => {
    const permissions = new PermissionSet(['sales.invoice:*']);
    expect(permissions.can('sales.invoice', 'post')).toBe(true);
    expect(permissions.can('finance.journal', 'post')).toBe(false);
  });

  it('honours an action wildcard across resources', () => {
    const permissions = new PermissionSet(['*:read']);
    expect(permissions.can('finance.journal', 'read')).toBe(true);
    expect(permissions.can('finance.journal', 'post')).toBe(false);
  });

  it('lets a super administrator do anything', () => {
    const permissions = new PermissionSet([], true);
    expect(permissions.can('platform.settings', 'update')).toBe(true);
  });

  it('supports field-level grants', () => {
    const permissions = new PermissionSet([
      'inventory.product:read',
      'inventory.product:read:costPrice',
    ]);
    expect(permissions.can('inventory.product', 'read', 'costPrice')).toBe(true);

    const restricted = new PermissionSet(['inventory.product:read']);
    expect(restricted.can('inventory.product', 'read')).toBe(true);
    expect(restricted.can('inventory.product', 'read', 'costPrice')).toBe(false);
  });

  it('reports which fields must be stripped from a response', () => {
    const permissions = new PermissionSet(['hr.employee:read']);
    expect(permissions.deniedFields('hr.employee', ['fullNameAr', 'basicSalary'])).toEqual([
      'basicSalary',
    ]);
  });

  it('returns a bilingual refusal naming the action and resource', () => {
    const permissions = new PermissionSet([]);
    const result = permissions.require('finance.journal', 'post');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.messageAr).toContain('الترحيل');
      expect(result.error.messageAr).toContain('القيود المحاسبية');
      expect(result.error.messageEn).toContain('post');
      expect(result.error.httpStatus).toBe(403);
    }
  });
});

describe('system roles', () => {
  it('separates raising an invoice from posting it', () => {
    const salesRep = SYSTEM_ROLES.find((role) => role.name === 'SALES_REPRESENTATIVE');
    const permissions = new PermissionSet(salesRep?.permissions ?? []);

    expect(permissions.can('sales.invoice', 'create')).toBe(true);
    expect(permissions.can('sales.invoice', 'post')).toBe(false);
  });

  it('gives the auditor read access without any ability to change anything', () => {
    const auditor = SYSTEM_ROLES.find((role) => role.name === 'AUDITOR');
    const permissions = new PermissionSet(auditor?.permissions ?? []);

    expect(permissions.can('finance.journal', 'read')).toBe(true);
    expect(permissions.can('platform.audit', 'read')).toBe(true);
    expect(permissions.can('finance.journal', 'post')).toBe(false);
    expect(permissions.can('sales.invoice', 'create')).toBe(false);
  });

  it('ships no role that both creates and posts a sales invoice', () => {
    for (const role of SYSTEM_ROLES) {
      if (role.name === 'SYSTEM_ADMINISTRATOR') continue;
      const permissions = new PermissionSet(role.permissions);
      const createsAndPosts =
        permissions.can('sales.invoice', 'create') && permissions.can('sales.invoice', 'post');
      expect(createsAndPosts, `${role.name} holds a toxic combination`).toBe(false);
    }
  });
});

describe('segregation of duties', () => {
  const actors = {
    createdById: 'user-a',
    approvedById: null,
    postedById: null,
  };

  it('stops the creator from posting their own document', () => {
    const result = checkSegregationOfDuties({
      step: 'post',
      userId: 'user-a',
      actors,
      enforce: true,
      isSuperAdmin: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SOD_VIOLATION');
  });

  it('allows a different user to post it', () => {
    const result = checkSegregationOfDuties({
      step: 'post',
      userId: 'user-b',
      actors,
      enforce: true,
      isSuperAdmin: false,
    });
    expect(result.ok).toBe(true);
  });

  it('stops the creator from approving their own document', () => {
    const result = checkSegregationOfDuties({
      step: 'approve',
      userId: 'user-a',
      actors,
      enforce: true,
      isSuperAdmin: false,
    });
    expect(result.ok).toBe(false);
  });

  it('stops the approver from recording the payment', () => {
    const result = checkSegregationOfDuties({
      step: 'pay',
      userId: 'user-b',
      actors: { ...actors, approvedById: 'user-b' },
      enforce: true,
      isSuperAdmin: false,
    });
    expect(result.ok).toBe(false);
  });

  it('permits the approver to also post — both are supervisory acts', () => {
    // Forbidding this would make a two-person finance department unable to
    // operate, and a control that cannot be followed is a control that is
    // bypassed.
    const result = checkSegregationOfDuties({
      step: 'post',
      userId: 'user-b',
      actors: { ...actors, approvedById: 'user-b' },
      enforce: true,
      isSuperAdmin: false,
    });
    expect(result.ok).toBe(true);
  });

  it('can be disabled by tenant policy', () => {
    const result = checkSegregationOfDuties({
      step: 'post',
      userId: 'user-a',
      actors,
      enforce: false,
      isSuperAdmin: false,
    });
    expect(result.ok).toBe(true);
  });

  it('exempts a super administrator', () => {
    const result = checkSegregationOfDuties({
      step: 'post',
      userId: 'user-a',
      actors,
      enforce: true,
      isSuperAdmin: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe('toxic combination detection', () => {
  it('flags creating and posting sales invoices', () => {
    const findings = findToxicCombinations(['sales.invoice:create', 'sales.invoice:post']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.messageEn).toContain('creating and posting sales invoices');
  });

  it('sees through a wildcard grant', () => {
    const findings = findToxicCombinations(['sales.invoice:*']);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags the full-admin grant as the conflict it is', () => {
    const findings = findToxicCombinations(['*:*']);
    expect(findings.length).toBeGreaterThan(3);
  });

  it('finds nothing wrong with a properly separated role', () => {
    expect(findToxicCombinations(['sales.invoice:create', 'sales.customer:read'])).toEqual([]);
  });
});

describe('password policy', () => {
  it('accepts a strong password', () => {
    expect(validatePasswordStrength('Erp@Demo2026!').ok).toBe(true);
  });

  it('rejects one that is too short', () => {
    expect(validatePasswordStrength('Ab1!xyz').ok).toBe(false);
  });

  it('rejects one lacking character variety', () => {
    expect(validatePasswordStrength('abcdefghijklmnop').ok).toBe(false);
  });

  it('rejects one containing the username', () => {
    const result = validatePasswordStrength('Mohammed@2026xyz', { username: 'mohammed' });
    expect(result.ok).toBe(false);
  });

  it('rejects one longer than bcrypt can actually hash', () => {
    // bcrypt silently truncates past 72 bytes; accepting a 200-character
    // password would mean only the first 72 bytes ever mattered.
    expect(validatePasswordStrength(`${'A1b!'.repeat(30)}`).ok).toBe(false);
  });

  it('flags a hash produced at a lower cost factor for rehashing', () => {
    expect(needsRehash('$2a$04$abcdefghijklmnopqrstuv')).toBe(true);
    expect(needsRehash('$2a$12$abcdefghijklmnopqrstuv')).toBe(false);
    expect(needsRehash('not-a-hash')).toBe(true);
  });

  it('escalates lockout with repeated failures', () => {
    expect(lockoutDurationSeconds(3)).toBe(0);
    expect(lockoutDurationSeconds(5)).toBe(60);
    expect(lockoutDurationSeconds(10)).toBe(900);
    expect(lockoutDurationSeconds(20)).toBe(3600);
  });
});
