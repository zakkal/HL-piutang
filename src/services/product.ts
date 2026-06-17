// ─── Product Service ───────────────────────────────────────────

import { supabaseAdmin } from '../config/supabase';
import { toDecimal, toNumeric, toNumber } from './financial';
import type { ProductRow, CreateProductInput, UpdateProductInput } from '../types';
import { NotFoundError, ConflictError } from '../utils/errors';

// ─── Read ──────────────────────────────────────────────────────

export async function listProducts(): Promise<any[]> {
  const { data, error } = await supabaseAdmin
    .from('products')
    .select('*')
    .is('deleted_at', null)
    .order('type')
    .order('name');

  if (error) throw new Error(`Failed to fetch products: ${error.message}`);

  return (data as ProductRow[]).map(p => ({
    ...p,
    cost_price: toNumber(toDecimal(p.cost_price)),
    base_price: toNumber(toDecimal(p.base_price)),
  }));
}

export async function getProduct(id: string): Promise<ProductRow> {
  const { data, error } = await supabaseAdmin
    .from('products')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .single();

  if (error || !data) throw new NotFoundError('Product', id);

  return data as ProductRow;
}

// Internal: get multiple products by IDs (for transaction creation)
export async function getProductsByIds(ids: string[]): Promise<ProductRow[]> {
  if (ids.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('products')
    .select('*')
    .in('id', ids)
    .is('deleted_at', null);

  if (error) throw new Error(`Failed to fetch products: ${error.message}`);

  return (data || []) as ProductRow[];
}

// ─── Create ────────────────────────────────────────────────────

export async function createProduct(input: CreateProductInput): Promise<ProductRow> {
  if (input.cost_price > input.base_price) {
    throw new ConflictError('Cost price cannot exceed base price');
  }

  const { data, error } = await supabaseAdmin
    .from('products')
    .insert({
      name: input.name,
      type: input.type,
      cost_price: toNumeric(toDecimal(input.cost_price)),
      base_price: toNumeric(toDecimal(input.base_price)),
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new ConflictError('Product name already exists');
    throw new Error(`Failed to create product: ${error.message}`);
  }

  return data as ProductRow;
}

// ─── Update ────────────────────────────────────────────────────

export async function updateProduct(id: string, input: UpdateProductInput): Promise<ProductRow> {
  await getProduct(id); // Verify exists

  const updates: Record<string, any> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.type !== undefined) updates.type = input.type;
  if (input.cost_price !== undefined) {
    updates.cost_price = toNumeric(toDecimal(input.cost_price));
  }
  if (input.base_price !== undefined) {
    updates.base_price = toNumeric(toDecimal(input.base_price));
  }

  if (Object.keys(updates).length > 0) {
    const { error } = await supabaseAdmin
      .from('products')
      .update(updates)
      .eq('id', id);

    if (error) throw new Error(`Failed to update product: ${error.message}`);
  }

  return getProduct(id);
}

// ─── Soft Delete ───────────────────────────────────────────────

export async function softDeleteProduct(id: string): Promise<void> {
  await getProduct(id); // Verify exists

  const { error } = await supabaseAdmin
    .from('products')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`Failed to delete product: ${error.message}`);
}
