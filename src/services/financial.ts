// ─── Financial Service — Decimal-Precision Business Logic ──────
// All monetary calculations use decimal.js to avoid floating-point errors.
// PostgreSQL NUMERIC(15,2) ↔ decimal.js Decimal with 2 decimal places.

import Decimal from 'decimal.js';
import type { CustomerDiscountRow, ProductType } from '../types';

// Configure decimal.js for financial precision
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export type D = Decimal;
export const D = Decimal;

// ─── Helpers ───────────────────────────────────────────────────

/** Parse a NUMERIC string from Postgres to Decimal */
export function toDecimal(value: string | number | Decimal): Decimal {
  return new Decimal(value);
}

/** Round to 2 decimal places (cents) */
export function toCents(d: Decimal): Decimal {
  return d.toDecimalPlaces(2);
}

/** Convert Decimal to number for JSON serialization */
export function toNumber(d: Decimal): number {
  return d.toNumber();
}

/** Convert Decimal to string for Postgres insert */
export function toNumeric(d: Decimal): string {
  return d.toDecimalPlaces(2).toString();
}

// ─── 1. Cascading Discount Rule ───────────────────────────────
// Formula: Base × Π(1 − d_i / 100)
// Discounts are applied SEQUENTIALLY, NOT summed.
// Example: Base = 100, Discounts [20, 20, 10]
//   → 100 × 0.8 × 0.8 × 0.9 = 57.6 (effective discount 42.4%)

export function applyCascadingDiscount(
  basePrice: Decimal,
  discounts: Array<{ discount_percentage: string | number; step_order: number }>
): Decimal {
  // Sort by step_order ascending to ensure correct sequential application
  const sorted = [...discounts].sort((a, b) => a.step_order - b.step_order);

  let result = basePrice;

  for (const discount of sorted) {
    const pct = toDecimal(discount.discount_percentage);
    const multiplier = toDecimal(1).minus(pct.dividedBy(100));
    result = result.times(multiplier);
  }

  return toCents(result);
}

/**
 * Calculate the effective discount percentage from cascading discounts.
 * Effective % = (1 - Π(1 − d_i/100)) × 100
 */
export function effectiveDiscountPercentage(
  discounts: Array<{ discount_percentage: string | number; step_order: number }>
): Decimal {
  if (discounts.length === 0) return new Decimal(0);

  const sorted = [...discounts].sort((a, b) => a.step_order - b.step_order);
  let product = new Decimal(1);

  for (const discount of sorted) {
    const pct = toDecimal(discount.discount_percentage);
    product = product.times(toDecimal(1).minus(pct.dividedBy(100)));
  }

  const effectiveRate = toDecimal(1).minus(product);
  return toCents(effectiveRate.times(100));
}

// ─── 2. Transaction Totals ────────────────────────────────────
// Line Omzet    = unit_discounted_price × quantity
// Tx Omzet      = Σ Line Omzet (EXCLUDING ongkir)
// Amount Owed   = Tx Omzet + Ongkir
// Line Laba HL  = (unit_discounted_price − unit_cost_price) × quantity
// Ongkir is Pass-Through → Does NOT affect Laba HL

export interface LineCalculation {
  unit_cost_price: Decimal;
  unit_discounted_price: Decimal;
  line_omzet: Decimal;
  line_laba: Decimal;
}

export interface TransactionCalculation {
  lines: LineCalculation[];
  transaction_omzet: Decimal;  // Sum of line_omzet (excl ongkir)
  amount_owed: Decimal;        // transaction_omzet + ongkir
  total_laba: Decimal;         // Sum of line_laba
  ongkir: Decimal;
}

/**
 * Calculate a single transaction line item.
 * If is_bonus is true, unit_discounted_price = 0, line_omzet = 0, line_laba = 0.
 * Bonus item cost_price is NOT deducted from business Laba.
 */
export function calculateLine(
  basePrice: Decimal,
  costPrice: Decimal,
  quantity: number,
  isBonus: boolean,
  discounts?: Array<{ discount_percentage: string | number; step_order: number }>
): LineCalculation {
  if (isBonus) {
    return {
      unit_cost_price: toCents(costPrice),
      unit_discounted_price: new Decimal(0),
      line_omzet: new Decimal(0),
      line_laba: new Decimal(0),
    };
  }

  const discountedPrice = discounts && discounts.length > 0
    ? applyCascadingDiscount(basePrice, discounts)
    : toCents(basePrice);

  const lineOmzet = toCents(discountedPrice.times(quantity));
  const lineLaba = toCents(discountedPrice.minus(costPrice).times(quantity));

  return {
    unit_cost_price: toCents(costPrice),
    unit_discounted_price: toCents(discountedPrice),
    line_omzet: lineOmzet,
    line_laba: lineLaba,
  };
}

/**
 * Calculate full transaction totals from multiple lines.
 */
export function calculateTransaction(
  lines: LineCalculation[],
  ongkir: Decimal
): TransactionCalculation {
  const transactionOmzet = lines.reduce(
    (sum, line) => sum.plus(line.line_omzet),
    new Decimal(0)
  );
  const totalLaba = lines.reduce(
    (sum, line) => sum.plus(line.line_laba),
    new Decimal(0)
  );

  return {
    lines,
    transaction_omzet: toCents(transactionOmzet),
    amount_owed: toCents(transactionOmzet.plus(ongkir)),
    total_laba: toCents(totalLaba),
    ongkir: toCents(ongkir),
  };
}

// ─── 3. Cash Basis Principle ──────────────────────────────────
// Omzet, Laba HL, and bonus accumulation are ONLY recognized
// when status = 'Lunas'. If status = 'Piutang', values must
// NOT be included in reports/recaps.

export function isRecognized(status: string): boolean {
  return status === 'Lunas';
}

// ─── 4. Bonus Stacking Logic ──────────────────────────────────
// accumulated_paid_omzet = Σ Omzet from Lunas transactions (excl bonus)
// bonus_earned = floor(accumulated / threshold)
// bonuses_remaining = bonus_earned − bonuses_already_granted
// carry_over = accumulated − (bonus_earned × threshold)
// Bonus transactions: all items free (unit_discounted_price=0, line_omzet=0, line_laba=0)

export interface BonusCalculation {
  accumulated_paid_omzet: Decimal;
  bonus_threshold: Decimal;
  bonuses_earned: number;
  bonuses_already_granted: number;
  bonuses_remaining: number;
  carry_over_omzet: Decimal;
}

export function calculateBonusStatus(
  accumulatedPaidOmzet: Decimal,
  bonusThreshold: Decimal,
  bonusesAlreadyGranted: number
): BonusCalculation {
  const threshold = bonusThreshold;

  // Prevent division by zero
  const bonusesEarned = threshold.isZero()
    ? 0
    : accumulatedPaidOmzet.dividedBy(threshold).floor().toNumber();

  const bonusesRemaining = Math.max(bonusesEarned - bonusesAlreadyGranted, 0);
  const carryOver = threshold.isZero()
    ? accumulatedPaidOmzet
    : toCents(accumulatedPaidOmzet.minus(toDecimal(bonusesEarned).times(threshold)));

  return {
    accumulated_paid_omzet: toCents(accumulatedPaidOmzet),
    bonus_threshold: toCents(threshold),
    bonuses_earned: bonusesEarned,
    bonuses_already_granted: bonusesAlreadyGranted,
    bonuses_remaining: bonusesRemaining,
    carry_over_omzet: carryOver,
  };
}

// ─── 5. Discount Schema Lookup ────────────────────────────────
// Given a list of customer discounts, filter by product type.

export function getDiscountsForType(
  allDiscounts: CustomerDiscountRow[],
  productType: ProductType
): Array<{ discount_percentage: string; step_order: number }> {
  return allDiscounts
    .filter(d => d.type === productType)
    .map(d => ({
      discount_percentage: d.discount_percentage,
      step_order: d.step_order,
    }));
}
