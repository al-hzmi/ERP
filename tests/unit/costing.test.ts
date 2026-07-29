import { describe, expect, it } from 'vitest';
import {
  applyAverageIssue,
  applyAverageReceipt,
  consumeFifo,
  findExpiredLayers,
  findExpiringLayers,
  valueIssue,
  type CostLayerSnapshot,
} from '@/lib/domain/inventory/costing';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';
import { unwrap } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';

const NAMES = {
  productNameAr: 'حاسب محمول',
  productNameEn: 'Laptop',
  warehouseNameAr: 'المستودع الرئيسي',
  warehouseNameEn: 'Main Warehouse',
  functionalCurrency: 'SAR',
} as const;

function layer(overrides: Partial<CostLayerSnapshot> & { id: string }): CostLayerSnapshot {
  return {
    remainingQuantity: Quantity.of('10'),
    unitCost: Money.of('100', 'SAR'),
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    batchNumber: null,
    expiryDate: null,
    ...overrides,
  };
}

describe('consumeFifo', () => {
  it('consumes the oldest layer first', () => {
    const layers = [
      layer({ id: 'newer', unitCost: Money.of('120', 'SAR'), receivedAt: new Date('2026-02-01T00:00:00Z') }),
      layer({ id: 'older', unitCost: Money.of('100', 'SAR'), receivedAt: new Date('2026-01-01T00:00:00Z') }),
    ];

    const result = unwrap(consumeFifo(layers, Quantity.of('5'), NAMES));

    expect(result.consumptions).toHaveLength(1);
    expect(result.consumptions[0]?.layerId).toBe('older');
    expect(result.totalCost.toFixed(2)).toBe('500.00');
  });

  it('spans several layers and costs each at its own rate', () => {
    const layers = [
      layer({ id: 'l1', unitCost: Money.of('100', 'SAR'), receivedAt: new Date('2026-01-01T00:00:00Z') }),
      layer({ id: 'l2', unitCost: Money.of('130', 'SAR'), receivedAt: new Date('2026-02-01T00:00:00Z') }),
    ];

    const result = unwrap(consumeFifo(layers, Quantity.of('15'), NAMES));

    // 10 @ 100 + 5 @ 130 = 1650
    expect(result.totalCost.toFixed(2)).toBe('1650.00');
    expect(result.consumptions).toHaveLength(2);
    expect(result.averageUnitCost.toFixed(2)).toBe('110.00');
  });

  it('refuses an issue larger than what is on hand, naming the numbers', () => {
    const result = consumeFifo([layer({ id: 'l1' })], Quantity.of('50'), NAMES);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INSUFFICIENT_STOCK');
      expect(result.error.messageAr).toContain('50');
      expect(result.error.messageAr).toContain('10');
      expect(result.error.messageAr).toContain('حاسب محمول');
      expect(result.error.messageAr).toContain('المستودع الرئيسي');
    }
  });

  it('refuses to issue an expired batch', () => {
    const expired = layer({
      id: 'expired',
      batchNumber: 'B-001',
      expiryDate: unwrap(DateOnly.create('2026-01-31')),
    });

    const result = consumeFifo([expired], Quantity.of('1'), {
      ...NAMES,
      issueDate: unwrap(DateOnly.create('2026-03-01')),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EXPIRED_BATCH');
  });

  it('allows an issue when the batch expires later today', () => {
    const fresh = layer({
      id: 'fresh',
      expiryDate: unwrap(DateOnly.create('2026-03-01')),
    });

    const result = consumeFifo([fresh], Quantity.of('1'), {
      ...NAMES,
      issueDate: unwrap(DateOnly.create('2026-03-01')),
    });

    expect(result.ok).toBe(true);
  });

  it('restricts consumption to a named batch when asked', () => {
    const layers = [
      layer({ id: 'a', batchNumber: 'B1', receivedAt: new Date('2026-01-01T00:00:00Z') }),
      layer({ id: 'b', batchNumber: 'B2', unitCost: Money.of('200', 'SAR'), receivedAt: new Date('2026-02-01T00:00:00Z') }),
    ];

    const result = unwrap(consumeFifo(layers, Quantity.of('5'), { ...NAMES, batchNumber: 'B2' }));

    expect(result.consumptions[0]?.layerId).toBe('b');
    expect(result.totalCost.toFixed(2)).toBe('1000.00');
  });

  it('ignores exhausted layers', () => {
    const layers = [
      layer({ id: 'empty', remainingQuantity: Quantity.zero(), receivedAt: new Date('2026-01-01T00:00:00Z') }),
      layer({ id: 'live', receivedAt: new Date('2026-02-01T00:00:00Z') }),
    ];

    const result = unwrap(consumeFifo(layers, Quantity.of('3'), NAMES));
    expect(result.consumptions[0]?.layerId).toBe('live');
  });

  it('refuses a non-positive issue quantity', () => {
    expect(consumeFifo([layer({ id: 'l1' })], Quantity.zero(), NAMES).ok).toBe(false);
    expect(consumeFifo([layer({ id: 'l1' })], Quantity.of('-1'), NAMES).ok).toBe(false);
  });

  it('is deterministic when two layers share a timestamp', () => {
    const layers = [
      layer({ id: 'bbb', unitCost: Money.of('200', 'SAR') }),
      layer({ id: 'aaa', unitCost: Money.of('100', 'SAR') }),
    ];
    const first = unwrap(consumeFifo(layers, Quantity.of('5'), NAMES));
    const second = unwrap(consumeFifo([...layers].reverse(), Quantity.of('5'), NAMES));
    expect(first.consumptions[0]?.layerId).toBe(second.consumptions[0]?.layerId);
  });
});

describe('weighted average', () => {
  it('recomputes the average from total value over total quantity', () => {
    const start = {
      quantityOnHand: Quantity.of('10'),
      averageCost: Money.of('100', 'SAR'),
      totalValue: Money.of('1000', 'SAR'),
    };

    const after = unwrap(applyAverageReceipt(start, Quantity.of('10'), Money.of('140', 'SAR')));

    expect(after.quantityOnHand.toDisplayString()).toBe('20');
    expect(after.averageCost.toFixed(2)).toBe('120.00');
    expect(after.totalValue.toFixed(2)).toBe('2400.00');
  });

  it('keeps value equal to quantity times average after every receipt', () => {
    let position = {
      quantityOnHand: Quantity.zero(),
      averageCost: Money.zero('SAR'),
      totalValue: Money.zero('SAR'),
    };

    for (let index = 1; index <= 25; index += 1) {
      position = unwrap(
        applyAverageReceipt(
          position,
          Quantity.of(String(index * 3)),
          Money.of((7.77 * index).toFixed(4), 'SAR'),
        ),
      );

      const derived = position.averageCost.multiply(position.quantityOnHand.toString());
      // Within one halala — the residue a 4-decimal average necessarily leaves.
      expect(Number(derived.subtract(position.totalValue).abs().toFixed(2))).toBeLessThanOrEqual(0.01);
    }
  });

  it('does not move the average on an issue', () => {
    const start = {
      quantityOnHand: Quantity.of('20'),
      averageCost: Money.of('120', 'SAR'),
      totalValue: Money.of('2400', 'SAR'),
    };

    const result = unwrap(applyAverageIssue(start, Quantity.of('5'), NAMES));

    expect(result.cost.toFixed(2)).toBe('600.00');
    expect(result.position.averageCost.toFixed(2)).toBe('120.00');
    expect(result.position.quantityOnHand.toDisplayString()).toBe('15');
  });

  it('zeroes the value when a position is fully depleted', () => {
    const start = {
      quantityOnHand: Quantity.of('3'),
      averageCost: Money.of('33.3333', 'SAR'),
      totalValue: Money.of('99.9999', 'SAR'),
    };

    const result = unwrap(applyAverageIssue(start, Quantity.of('3'), NAMES));

    expect(result.position.quantityOnHand.isZero).toBe(true);
    expect(result.position.totalValue.isZero).toBe(true);
  });

  it('refuses to issue more than is on hand', () => {
    const start = {
      quantityOnHand: Quantity.of('5'),
      averageCost: Money.of('100', 'SAR'),
      totalValue: Money.of('500', 'SAR'),
    };

    const result = applyAverageIssue(start, Quantity.of('10'), NAMES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('permits a negative position when the tenant allows it', () => {
    const start = {
      quantityOnHand: Quantity.of('5'),
      averageCost: Money.of('100', 'SAR'),
      totalValue: Money.of('500', 'SAR'),
    };

    const result = unwrap(applyAverageIssue(start, Quantity.of('10'), NAMES, true));
    expect(result.position.quantityOnHand.toDisplayString()).toBe('-5');
  });
});

describe('valueIssue', () => {
  const position = {
    quantityOnHand: Quantity.of('20'),
    averageCost: Money.of('110', 'SAR'),
    totalValue: Money.of('2200', 'SAR'),
  };

  const layers = [
    layer({ id: 'l1', unitCost: Money.of('100', 'SAR'), receivedAt: new Date('2026-01-01T00:00:00Z') }),
    layer({ id: 'l2', unitCost: Money.of('120', 'SAR'), receivedAt: new Date('2026-02-01T00:00:00Z') }),
  ];

  it('routes to FIFO and reports the layers consumed', () => {
    const result = unwrap(
      valueIssue({
        method: 'FIFO',
        layers,
        position,
        quantity: Quantity.of('15'),
        options: NAMES,
        allowNegativeStock: false,
      }),
    );

    expect(result.totalCost.toFixed(2)).toBe('1600.00'); // 10@100 + 5@120
    expect(result.consumptions).toHaveLength(2);
  });

  it('routes to weighted average and reports no layer consumption', () => {
    const result = unwrap(
      valueIssue({
        method: 'WEIGHTED_AVERAGE',
        layers,
        position,
        quantity: Quantity.of('15'),
        options: NAMES,
        allowNegativeStock: false,
      }),
    );

    expect(result.totalCost.toFixed(2)).toBe('1650.00'); // 15 @ 110
    expect(result.consumptions).toHaveLength(0);
  });
});

describe('expiry reporting', () => {
  const asOf = unwrap(DateOnly.create('2026-03-01'));

  const layers = [
    layer({ id: 'expired', expiryDate: unwrap(DateOnly.create('2026-02-01')) }),
    layer({ id: 'soon', expiryDate: unwrap(DateOnly.create('2026-03-20')) }),
    layer({ id: 'later', expiryDate: unwrap(DateOnly.create('2027-01-01')) }),
    layer({ id: 'none' }),
    layer({ id: 'empty', remainingQuantity: Quantity.zero(), expiryDate: unwrap(DateOnly.create('2026-01-01')) }),
  ];

  it('finds expired layers that still carry stock', () => {
    const expired = findExpiredLayers(layers, asOf);
    expect(expired.map((entry) => entry.id)).toEqual(['expired']);
  });

  it('finds layers expiring within a horizon', () => {
    const expiring = findExpiringLayers(layers, 30, asOf);
    expect(expiring.map((entry) => entry.id)).toEqual(['soon']);
  });
});
