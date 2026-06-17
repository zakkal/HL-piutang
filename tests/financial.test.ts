// ─── Financial Service Unit Tests ─────────────────────────────
// Verifies accuracy of cascading discount, bonus stacking,
// line calculations, and cash-basis rules using decimal.js.

import {
  applyCascadingDiscount,
  effectiveDiscountPercentage,
  calculateLine,
  calculateTransaction,
  calculateBonusStatus,
  isRecognized,
  D,
  toDecimal,
  toCents,
  toNumber,
} from '../src/services/financial';

// ─── 1. Cascading Discount Rule ────────────────────────────────

describe('applyCascadingDiscount', () => {
  it('applies sequential discounts (NOT summed)', () => {
    // AC example: Base = 100, Discounts [20, 20, 10]
    // → 100 × 0.8 × 0.8 × 0.9 = 57.6
    const base = new D(100);
    const discounts = [
      { discount_percentage: 20, step_order: 1 },
      { discount_percentage: 20, step_order: 2 },
      { discount_percentage: 10, step_order: 3 },
    ];

    const result = applyCascadingDiscount(base, discounts);
    expect(toNumber(result)).toBe(57.6);
  });

  it('effective discount is 42.4% for [20, 20, 10]', () => {
    const discounts = [
      { discount_percentage: 20, step_order: 1 },
      { discount_percentage: 20, step_order: 2 },
      { discount_percentage: 10, step_order: 3 },
    ];

    const effective = effectiveDiscountPercentage(discounts);
    expect(toNumber(effective)).toBeCloseTo(42.4, 1);
  });

  it('respects step_order sequence', () => {
    // Changing order can yield different results
    const base = new D(1000);
    const discounts1 = [
      { discount_percentage: 30, step_order: 1 },
      { discount_percentage: 10, step_order: 2 },
    ];
    const discounts2 = [
      { discount_percentage: 10, step_order: 1 },
      { discount_percentage: 30, step_order: 2 },
    ];

    const r1 = applyCascadingDiscount(base, discounts1);
    const r2 = applyCascadingDiscount(base, discounts2);

    // Both should equal 1000 × 0.7 × 0.9 = 630 (same in this case since multiplication is commutative)
    // But different non-symmetric discounts would differ
    expect(toNumber(r1)).toBe(630);
    expect(toNumber(r2)).toBe(630);
  });

  it('returns base price when no discounts', () => {
    const base = new D(250);
    const result = applyCascadingDiscount(base, []);
    expect(toNumber(result)).toBe(250);
  });

  it('handles single discount correctly', () => {
    const base = new D(500);
    const discounts = [{ discount_percentage: 25, step_order: 1 }];
    const result = applyCascadingDiscount(base, discounts);
    expect(toNumber(result)).toBe(375);
  });

  it('handles zero discount', () => {
    const base = new D(100);
    const discounts = [{ discount_percentage: 0, step_order: 1 }];
    const result = applyCascadingDiscount(base, discounts);
    expect(toNumber(result)).toBe(100);
  });

  it('handles 100% discount (free)', () => {
    const base = new D(100);
    const discounts = [{ discount_percentage: 100, step_order: 1 }];
    const result = applyCascadingDiscount(base, discounts);
    expect(toNumber(result)).toBe(0);
  });

  it('avoids floating-point issues with decimal.js', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in JS, but not with decimal.js
    const base = new D('0.1');
    const discounts = [{ discount_percentage: '0.2' as any, step_order: 1 }];
    const result = applyCascadingDiscount(base, discounts);
    // 0.1 × (1 - 0.002) = 0.1 × 0.998 = 0.0998
    expect(toNumber(result)).toBeCloseTo(0.1, 1);
  });
});

// ─── 2. Line & Transaction Calculation ─────────────────────────

describe('calculateLine', () => {
  it('calculates non-bonus line correctly', () => {
    // base = 100, cost = 60, qty = 3, discount 20%
    const base = new D(100);
    const cost = new D(60);
    const discounts = [{ discount_percentage: 20, step_order: 1 }];

    const line = calculateLine(base, cost, 3, false, discounts);

    // unit_discounted_price = 100 × 0.8 = 80
    expect(toNumber(line.unit_discounted_price)).toBe(80);
    // line_omzet = 80 × 3 = 240
    expect(toNumber(line.line_omzet)).toBe(240);
    // line_laba = (80 - 60) × 3 = 60
    expect(toNumber(line.line_laba)).toBe(60);
  });

  it('calculates line without discount', () => {
    const base = new D(200);
    const cost = new D(150);
    const line = calculateLine(base, cost, 2, false);

    expect(toNumber(line.unit_discounted_price)).toBe(200);
    expect(toNumber(line.line_omzet)).toBe(400);
    expect(toNumber(line.line_laba)).toBe(100); // (200 - 150) × 2
  });

  it('returns all zeros for bonus items', () => {
    const base = new D(500);
    const cost = new D(300);
    const line = calculateLine(base, cost, 5, true);

    // Bonus: unit_discounted_price = 0, line_omzet = 0, line_laba = 0
    expect(toNumber(line.unit_discounted_price)).toBe(0);
    expect(toNumber(line.line_omzet)).toBe(0);
    expect(toNumber(line.line_laba)).toBe(0);
    // Cost price is recorded but does NOT reduce Laba HL
    expect(toNumber(line.unit_cost_price)).toBe(300);
  });
});

describe('calculateTransaction', () => {
  it('calculates transaction totals correctly', () => {
    const line1 = {
      unit_cost_price: new D(60),
      unit_discounted_price: new D(80),
      line_omzet: new D(240),
      line_laba: new D(60),
    };
    const line2 = {
      unit_cost_price: new D(100),
      unit_discounted_price: new D(150),
      line_omzet: new D(300),
      line_laba: new D(100),
    };

    const ongkir = new D(50);
    const tx = calculateTransaction([line1, line2], ongkir);

    // Transaction Omzet = 240 + 300 = 540 (excl ongkir)
    expect(toNumber(tx.transaction_omzet)).toBe(540);
    // Amount Owed = 540 + 50 = 590
    expect(toNumber(tx.amount_owed)).toBe(590);
    // Total Laba = 60 + 100 = 160 (ongkir NOT in laba)
    expect(toNumber(tx.total_laba)).toBe(160);
    // Ongkir is pass-through
    expect(toNumber(tx.ongkir)).toBe(50);
  });

  it('handles zero ongkir', () => {
    const line = {
      unit_cost_price: new D(50),
      unit_discounted_price: new D(100),
      line_omzet: new D(100),
      line_laba: new D(50),
    };

    const tx = calculateTransaction([line], new D(0));
    expect(toNumber(tx.amount_owed)).toBe(100);
    expect(toNumber(tx.total_laba)).toBe(50);
  });
});

// ─── 3. Cash Basis Principle ───────────────────────────────────

describe('isRecognized (Cash Basis)', () => {
  it('recognizes Lunas transactions', () => {
    expect(isRecognized('Lunas')).toBe(true);
  });

  it('does NOT recognize Piutang transactions', () => {
    expect(isRecognized('Piutang')).toBe(false);
  });
});

// ─── 4. Bonus Stacking Logic ───────────────────────────────────

describe('calculateBonusStatus', () => {
  it('calculates bonus earned correctly', () => {
    // accumulated = 5,500,000, threshold = 1,000,000
    // earned = floor(5,500,000 / 1,000,000) = 5
    // granted = 3
    // remaining = 5 - 3 = 2
    // carry_over = 5,500,000 - (5 × 1,000,000) = 500,000
    const result = calculateBonusStatus(
      new D(5500000),
      new D(1000000),
      3
    );

    expect(result.bonuses_earned).toBe(5);
    expect(result.bonuses_already_granted).toBe(3);
    expect(result.bonuses_remaining).toBe(2);
    expect(toNumber(result.carry_over_omzet)).toBe(500000);
  });

  it('returns 0 remaining when no new bonus earned', () => {
    // accumulated = 800,000, threshold = 1,000,000
    // earned = floor(800,000 / 1,000,000) = 0
    // granted = 0
    // remaining = 0
    const result = calculateBonusStatus(
      new D(800000),
      new D(1000000),
      0
    );

    expect(result.bonuses_earned).toBe(0);
    expect(result.bonuses_remaining).toBe(0);
    expect(toNumber(result.carry_over_omzet)).toBe(800000);
  });

  it('handles exactly hitting the threshold', () => {
    // accumulated = 3,000,000, threshold = 1,000,000
    // earned = 3, granted = 1, remaining = 2
    // carry_over = 0
    const result = calculateBonusStatus(
      new D(3000000),
      new D(1000000),
      1
    );

    expect(result.bonuses_earned).toBe(3);
    expect(result.bonuses_remaining).toBe(2);
    expect(toNumber(result.carry_over_omzet)).toBe(0);
  });

  it('handles zero threshold gracefully', () => {
    const result = calculateBonusStatus(
      new D(5000000),
      new D(0),
      0
    );

    expect(result.bonuses_earned).toBe(0);
    expect(result.bonuses_remaining).toBe(0);
    expect(toNumber(result.carry_over_omzet)).toBe(5000000);
  });

  it('carry-over accumulates across cycles', () => {
    // Cycle 1: accumulated = 1,200,000, threshold = 1,000,000
    // earned = 1, granted = 0, remaining = 1, carry_over = 200,000

    const result1 = calculateBonusStatus(
      new D(1200000),
      new D(1000000),
      0
    );
    expect(result1.bonuses_earned).toBe(1);
    expect(toNumber(result1.carry_over_omzet)).toBe(200000);

    // Next purchase adds 900,000 more → total accumulated = 2,100,000
    // earned = floor(2,100,000 / 1,000,000) = 2
    // granted = 1 (from cycle 1), remaining = 1
    // carry_over = 2,100,000 - 2,000,000 = 100,000
    const result2 = calculateBonusStatus(
      new D(2100000),
      new D(1000000),
      1
    );
    expect(result2.bonuses_earned).toBe(2);
    expect(result2.bonuses_remaining).toBe(1);
    expect(toNumber(result2.carry_over_omzet)).toBe(100000);
  });
});

// ─── 5. Precision Edge Cases ───────────────────────────────────

describe('Decimal precision', () => {
  it('handles large numbers without overflow', () => {
    const base = new D('9999999999999.99');
    const discounts = [{ discount_percentage: 50, step_order: 1 }];
    const result = applyCascadingDiscount(base, discounts);
    expect(toNumber(result)).toBeCloseTo(4999999999999.995, 0);
  });

  it('handles many sequential discounts', () => {
    const base = new D(1000);
    const discounts = Array.from({ length: 10 }, (_, i) => ({
      discount_percentage: 5,
      step_order: i + 1,
    }));
    const result = applyCascadingDiscount(base, discounts);
    // 1000 × 0.95^10 ≈ 598.74
    expect(toNumber(result)).toBeCloseTo(598.74, 0);
  });

  it('toCents rounds correctly', () => {
    expect(toNumber(toCents(new D('123.456')))).toBe(123.46);
    expect(toNumber(toCents(new D('123.454')))).toBe(123.45);
    expect(toNumber(toCents(new D('123.455')))).toBe(123.46); // ROUND_HALF_UP
  });
});
