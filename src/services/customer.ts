// ─── Customer Service ──────────────────────────────────────────

import { supabaseAdmin } from '../config/supabase';
import {
  toDecimal,
  toCents,
  toNumber,
  toNumeric,
  effectiveDiscountPercentage,
  getDiscountsForType,
} from './financial';
import type {
  CustomerRow,
  CustomerDiscountRow,
  CustomerWithDiscounts,
  CreateCustomerInput,
  UpdateCustomerInput,
  DiscountInput,
  ProductType,
} from '../types';
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors';

// ─── Read ──────────────────────────────────────────────────────

export async function listCustomers(): Promise<CustomerWithDiscounts[]> {
  const { data: customers, error } = await supabaseAdmin
    .from('customers')
    .select('*, customer_discounts(*)')
    .is('deleted_at', null)
    .order('name');

  if (error) throw new Error(`Failed to fetch customers: ${error.message}`);

  return (customers as any[]).map(c => enrichCustomer(c));
}

export async function getCustomer(id: string): Promise<CustomerWithDiscounts> {
  const { data, error } = await supabaseAdmin
    .from('customers')
    .select('*, customer_discounts(*)')
    .eq('id', id)
    .is('deleted_at', null)
    .single();

  if (error || !data) throw new NotFoundError('Customer', id);

  return enrichCustomer(data as any);
}

// ─── Create ────────────────────────────────────────────────────

export async function createCustomer(input: CreateCustomerInput): Promise<CustomerWithDiscounts> {
  // Insert customer
  const { data: customer, error: custError } = await supabaseAdmin
    .from('customers')
    .insert({
      name: input.name,
      bonus_threshold: toNumeric(toDecimal(input.bonus_threshold)),
    })
    .select()
    .single();

  if (custError) {
    if (custError.code === '23505') throw new ConflictError('Customer name already exists');
    throw new Error(`Failed to create customer: ${custError.message}`);
  }

  // Insert discounts
  const discounts = input.discounts || [];
  if (discounts.length > 0) {
    await upsertDiscounts((customer as CustomerRow).id, discounts);
  }

  return getCustomer((customer as CustomerRow).id);
}

// ─── Update ────────────────────────────────────────────────────

export async function updateCustomer(
  id: string,
  input: UpdateCustomerInput
): Promise<CustomerWithDiscounts> {
  // Verify exists and not soft-deleted
  await getCustomer(id);

  const updates: Record<string, any> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.bonus_threshold !== undefined) {
    updates.bonus_threshold = toNumeric(toDecimal(input.bonus_threshold));
  }

  if (Object.keys(updates).length > 0) {
    const { error } = await supabaseAdmin
      .from('customers')
      .update(updates)
      .eq('id', id);

    if (error) throw new Error(`Failed to update customer: ${error.message}`);
  }

  // Replace discounts if provided
  if (input.discounts !== undefined) {
    await upsertDiscounts(id, input.discounts);
  }

  return getCustomer(id);
}

// ─── Soft Delete ───────────────────────────────────────────────

export async function softDeleteCustomer(id: string): Promise<void> {
  await getCustomer(id); // Verify exists

  const { error } = await supabaseAdmin
    .from('customers')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`Failed to delete customer: ${error.message}`);
}

// ─── Internal: Upsert Discounts ────────────────────────────────

async function upsertDiscounts(customerId: string, discounts: DiscountInput[]): Promise<void> {
  // Validate no duplicate (type, step_order)
  const seen = new Set<string>();
  for (const d of discounts) {
    const key = `${d.type}-${d.step_order}`;
    if (seen.has(key)) {
      throw new ValidationError(`Duplicate discount: type=${d.type}, step_order=${d.step_order}`);
    }
    seen.add(key);

    if (d.discount_percentage < 0 || d.discount_percentage > 100) {
      throw new ValidationError(`Discount percentage must be 0-100, got ${d.discount_percentage}`);
    }
  }

  // Delete existing discounts and re-insert (clean replace strategy)
  const { error: delError } = await supabaseAdmin
    .from('customer_discounts')
    .delete()
    .eq('customer_id', customerId);

  if (delError) throw new Error(`Failed to clear discounts: ${delError.message}`);

  if (discounts.length === 0) return;

  const rows = discounts.map(d => ({
    customer_id: customerId,
    type: d.type,
    step_order: d.step_order,
    discount_percentage: toNumeric(toDecimal(d.discount_percentage)),
  }));

  const { error: insError } = await supabaseAdmin
    .from('customer_discounts')
    .insert(rows);

  if (insError) {
    if (insError.code === '23505') {
      throw new ConflictError('Duplicate discount entry (type + step_order)');
    }
    throw new Error(`Failed to insert discounts: ${insError.message}`);
  }
}

// ─── Internal: Enrich customer with effective discount ─────────

function enrichCustomer(raw: any): CustomerWithDiscounts {
  const discounts: CustomerDiscountRow[] = raw.customer_discounts || [];
  const lmDiscounts = getDiscountsForType(discounts, 'LM' as ProductType);
  const brDiscounts = getDiscountsForType(discounts, 'BR' as ProductType);

  return {
    id: raw.id,
    name: raw.name,
    bonus_threshold: toNumber(toDecimal(raw.bonus_threshold)),
    deleted_at: raw.deleted_at,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    discounts,
    effective_discount_lm: toNumber(effectiveDiscountPercentage(lmDiscounts)),
    effective_discount_br: toNumber(effectiveDiscountPercentage(brDiscounts)),
  };
}

// ─── Get discounts for a customer (internal, for transaction service) ──

export async function getCustomerDiscounts(customerId: string): Promise<CustomerDiscountRow[]> {
  const { data, error } = await supabaseAdmin
    .from('customer_discounts')
    .select('*')
    .eq('customer_id', customerId)
    .order('type')
    .order('step_order');

  if (error) throw new Error(`Failed to fetch discounts: ${error.message}`);
  return (data || []) as CustomerDiscountRow[];
}
