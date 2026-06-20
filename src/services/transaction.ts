// ─── Transaction Service ───────────────────────────────────────
// Handles transaction creation with automatic discount calculation,
// settlement flows, and customer activity queries.

import { supabaseAdmin } from '../config/supabase';
import {
  toDecimal,
  toCents,
  toNumeric,
  toNumber,
  calculateLine,
  calculateTransaction,
  getDiscountsForType,
  D,
} from './financial';
import { getCustomerDiscounts } from './customer';
import { getProductsByIds } from './product';
import type {
  TransactionRow,
  TransactionItemRow,
  TransactionWithItems,
  CustomerActivitySummary,
  CreateTransactionInput,
  BonusStatus,
} from '../types';
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors';

// ─── Create Transaction (Atomic) ───────────────────────────────
// The Node.js backend calculates unit_discounted_price server-side.
// Users CANNOT send fabricated prices from the frontend.

export async function createTransaction(
  input: CreateTransactionInput
): Promise<TransactionWithItems> {
  // 1. Verify nomor_bon is unique
  const { data: existing } = await supabaseAdmin
    .from('transactions')
    .select('id')
    .eq('nomor_bon', input.nomor_bon)
    .maybeSingle();

  if (existing) {
    throw new ConflictError(`Nomor Bon '${input.nomor_bon}' already exists`);
  }

  // 2. Fetch products for all line items
  const productIds = input.items.map(item => item.product_id);
  const products = await getProductsByIds(productIds);

  if (products.length !== productIds.length) {
    const foundIds = new Set(products.map(p => p.id));
    const missing = productIds.filter(id => !foundIds.has(id));
    throw new NotFoundError(`Products not found: ${missing.join(', ')}`);
  }

  // 3. Fetch customer discount schema
  const discounts = await getCustomerDiscounts(input.customer_id);

  // 4. Calculate each line item using decimal.js
  const isBonus = input.is_bonus ?? false;
  const productMap = new Map(products.map(p => [p.id, p]));

  const lineCalcs = input.items.map(item => {
    const product = productMap.get(item.product_id)!;
    const basePrice = toDecimal(product.base_price);
    const costPrice = toDecimal(product.cost_price);
    const productDiscounts = getDiscountsForType(discounts, product.type as any);

    return calculateLine(basePrice, costPrice, item.quantity, isBonus, productDiscounts);
  });

  // 5. Calculate transaction totals
  const ongkir = toDecimal(input.ongkir ?? 0);
  const txCalc = calculateTransaction(lineCalcs, ongkir);

  // 6. Insert transaction + items atomically using Supabase RPC
  // The RPC function create_transaction_with_items ensures both
  // the transaction and its items are saved in a single DB transaction.
  const itemsJson = input.items.map((item, idx) => ({
    product_id: item.product_id,
    quantity: item.quantity,
    unit_cost_price: toNumeric(lineCalcs[idx].unit_cost_price),
    unit_discounted_price: toNumeric(lineCalcs[idx].unit_discounted_price),
    line_omzet: toNumeric(lineCalcs[idx].line_omzet),
    line_laba: toNumeric(lineCalcs[idx].line_laba),
  }));

  const { data: txId, error: rpcError } = await supabaseAdmin.rpc(
    'create_transaction_with_items',
    {
      p_nomor_bon: input.nomor_bon,
      p_customer_id: input.customer_id,
      p_tanggal: input.tanggal,
      p_ongkir: toNumeric(ongkir),
      p_deskripsi: input.deskripsi || '',
      p_is_bonus: isBonus,
      p_status: 'Piutang',
      p_items: itemsJson,
    }
  );

  if (rpcError) {
    if (rpcError.code === '23505' || rpcError.message?.includes('unique')) {
      throw new ConflictError(`Nomor Bon '${input.nomor_bon}' already exists`);
    }
    // Fallback to non-atomic insert if RPC not deployed yet
    console.warn('[WARN] RPC not available, falling back to two-step insert:', rpcError.message);
    return createTransactionFallback(input, lineCalcs, ongkir, isBonus);
  }

  return getTransactionWithItems(txId as string);
}

// ─── Fallback: Two-step insert (if RPC not deployed) ──────────

async function createTransactionFallback(
  input: CreateTransactionInput,
  lineCalcs: any[],
  ongkir: any,
  isBonus: boolean
): Promise<TransactionWithItems> {
  const { data: txRow, error: txError } = await supabaseAdmin
    .from('transactions')
    .insert({
      nomor_bon: input.nomor_bon,
      customer_id: input.customer_id,
      tanggal: input.tanggal,
      ongkir: toNumeric(ongkir),
      deskripsi: input.deskripsi || '',
      is_bonus: isBonus,
      status: 'Piutang',
    })
    .select()
    .single();

  if (txError) {
    if (txError.code === '23505') {
      throw new ConflictError(`Nomor Bon '${input.nomor_bon}' already exists`);
    }
    throw new Error(`Failed to create transaction: ${txError.message}`);
  }

  const txId = (txRow as TransactionRow).id;

  const itemRows = input.items.map((item, idx) => ({
    transaction_id: txId,
    product_id: item.product_id,
    quantity: item.quantity,
    unit_cost_price: toNumeric(lineCalcs[idx].unit_cost_price),
    unit_discounted_price: toNumeric(lineCalcs[idx].unit_discounted_price),
    line_omzet: toNumeric(lineCalcs[idx].line_omzet),
    line_laba: toNumeric(lineCalcs[idx].line_laba),
  }));

  const { error: itemsError } = await supabaseAdmin
    .from('transaction_items')
    .insert(itemRows);

  if (itemsError) {
    // Compensating transaction: delete the orphaned transaction
    await supabaseAdmin.from('transactions').delete().eq('id', txId);
    throw new Error(`Failed to create transaction items: ${itemsError.message}`);
  }

  return getTransactionWithItems(txId);
}

// ─── Get Transaction ───────────────────────────────────────────

export async function getTransactionWithItems(id: string): Promise<TransactionWithItems> {
  const { data: tx, error: txError } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('id', id)
    .single();

  if (txError || !tx) throw new NotFoundError('Transaction', id);

  const { data: items, error: itemsError } = await supabaseAdmin
    .from('transaction_items')
    .select('*')
    .eq('transaction_id', id);

  if (itemsError) throw new Error(`Failed to fetch items: ${itemsError.message}`);

  return enrichTransaction(tx as TransactionRow, (items || []) as TransactionItemRow[]);
}

// ─── Settle Single Transaction ─────────────────────────────────

export async function settleTransaction(
  id: string,
  tanggalPelunasan: string
): Promise<TransactionWithItems> {
  const tx = await getTransactionWithItems(id);

  if (tx.status === 'Lunas') {
    throw new ValidationError('Transaction is already settled (Lunas)');
  }

  const { error } = await supabaseAdmin
    .from('transactions')
    .update({
      status: 'Lunas',
      tanggal_pelunasan: tanggalPelunasan,
    })
    .eq('id', id);

  if (error) throw new Error(`Failed to settle transaction: ${error.message}`);

  return getTransactionWithItems(id);
}

// ─── Settle All Piutang for a Month ───────────────────────────

export async function settleMonth(
  customerId: string,
  month: number,
  year: number,
  tanggalPelunasan: string
): Promise<{ settled_count: number }> {
  // Find all Piutang transactions for this customer in the given month
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const { data: piutangTxs, error } = await supabaseAdmin
    .from('transactions')
    .select('id')
    .eq('customer_id', customerId)
    .eq('status', 'Piutang')
    .gte('tanggal', startDate)
    .lte('tanggal', endDate);

  if (error) throw new Error(`Failed to find piutang transactions: ${error.message}`);

  if (!piutangTxs || piutangTxs.length === 0) {
    return { settled_count: 0 };
  }

  const { error: updateError } = await supabaseAdmin
    .from('transactions')
    .update({
      status: 'Lunas',
      tanggal_pelunasan: tanggalPelunasan,
    })
    .in('id', piutangTxs.map(t => t.id));

  if (updateError) {
    throw new Error(`Failed to settle transactions: ${updateError.message}`);
  }

  return { settled_count: piutangTxs.length };
}

// ─── Customer Activity ─────────────────────────────────────────

export async function getCustomerActivity(
  customerId: string,
  month: number,
  year: number
): Promise<CustomerActivitySummary> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // Fetch all transactions for this customer in the month
  const { data: txs, error } = await supabaseAdmin
    .from('transactions')
    .select('*, transaction_items(*, products(id, name, type))')
    .eq('customer_id', customerId)
    .gte('tanggal', startDate)
    .lte('tanggal', endDate)
    .order('tanggal');

  if (error) throw new Error(`Failed to fetch activity: ${error.message}`);

  const transactions = (txs || []).map((tx: any) =>
    enrichTransaction(tx, tx.transaction_items || [])
  );

  // Calculate summary metrics (Cash Basis: only Lunas + non-bonus)
  let totalPiutang = new D(0);
  let totalLunas = new D(0);
  let totalOmzetLm = new D(0);
  let totalOmzetBr = new D(0);
  let totalLabaHl = new D(0);

  // Build product type lookup for LM/BR split
  const allProductIds = new Set<string>();
  for (const tx of transactions) {
    for (const item of tx.items) {
      allProductIds.add(item.product_id);
    }
  }
  const productTypeMap = await buildProductTypeMap([...allProductIds]);

  for (const tx of transactions) {
    if (tx.is_bonus) continue; // Skip bonus transactions in financial metrics

    const txOmzet = new D(tx.total_omzet);
    const txOngkir = new D(tx.ongkir);

    if (tx.status === 'Piutang') {
      totalPiutang = totalPiutang.plus(txOmzet).plus(txOngkir);
    } else if (tx.status === 'Lunas') {
      totalLunas = totalLunas.plus(txOmzet).plus(txOngkir);
      totalLabaHl = totalLabaHl.plus(new D(tx.total_laba));

      // Split omzet by product type (LM vs BR)
      for (const item of tx.items) {
        const itemOmzet = new D(item.line_omzet);
        const productType = productTypeMap.get(item.product_id);
        if (productType === 'LM') {
          totalOmzetLm = totalOmzetLm.plus(itemOmzet);
        } else if (productType === 'BR') {
          totalOmzetBr = totalOmzetBr.plus(itemOmzet);
        }
      }
    }
  }

  return {
    total_piutang: toNumber(totalPiutang),
    total_lunas: toNumber(totalLunas),
    total_omzet_lm: toNumber(totalOmzetLm),
    total_omzet_br: toNumber(totalOmzetBr),
    total_omzet: toNumber(totalOmzetLm.plus(totalOmzetBr)),
    total_laba_hl: toNumber(totalLabaHl),
    transactions,
  };
}

// ─── Get Bonus Status for Customer ─────────────────────────────

export async function getBonusStatus(customerId: string): Promise<BonusStatus> {
  const { data, error } = await supabaseAdmin
    .rpc('get_customer_bonus_status', { p_customer_id: customerId });

  if (error) {
    // Fallback: calculate in Node.js if RPC not yet deployed
    return calculateBonusInNode(customerId);
  }

  const row = (data as any[])[0];
  if (!row) return calculateBonusInNode(customerId);

  return {
    accumulated_paid_omzet: toNumber(new D(row.accumulated_paid_omzet)),
    bonus_threshold: toNumber(new D(row.bonus_threshold)),
    bonuses_earned: Number(row.bonuses_earned),
    bonuses_already_granted: Number(row.bonuses_already_granted),
    bonuses_remaining: Number(row.bonuses_remaining),
    carry_over_omzet: toNumber(new D(row.carry_over_omzet)),
  };
}

async function calculateBonusInNode(customerId: string): Promise<BonusStatus> {
  // Sum omzet from Lunas non-bonus transactions
  const { data: items } = await supabaseAdmin
    .from('transactions')
    .select('id, is_bonus, status, transaction_items(line_omzet)')
    .eq('customer_id', customerId)
    .eq('status', 'Lunas')
    .eq('is_bonus', false);

  let accumulated = new D(0);
  if (items) {
    for (const tx of items as any[]) {
      for (const item of tx.transaction_items || []) {
        accumulated = accumulated.plus(new D(item.line_omzet));
      }
    }
  }

  // Get threshold
  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('bonus_threshold')
    .eq('id', customerId)
    .single();

  const threshold = customer ? new D((customer as any).bonus_threshold) : new D(0);

  // Count granted bonuses
  const { count } = await supabaseAdmin
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .eq('is_bonus', true);

  const granted = count ?? 0;
  const earned = threshold.isZero() ? 0 : accumulated.dividedBy(threshold).floor().toNumber();
  const remaining = Math.max(earned - granted, 0);
  const carryOver = threshold.isZero()
    ? accumulated
    : accumulated.minus(new D(earned).times(threshold));

  return {
    accumulated_paid_omzet: toNumber(accumulated),
    bonus_threshold: toNumber(threshold),
    bonuses_earned: earned,
    bonuses_already_granted: granted,
    bonuses_remaining: remaining,
    carry_over_omzet: toNumber(toCents(carryOver)),
  };
}

// ─── Internal: Build product type lookup ──────────────────────

async function buildProductTypeMap(productIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (productIds.length === 0) return map;

  const { data, error } = await supabaseAdmin
    .from('products')
    .select('id, type')
    .in('id', productIds);

  if (error) return map;

  for (const p of (data || []) as Array<{ id: string; type: string }>) {
    map.set(p.id, p.type);
  }
  return map;
}

// ─── Internal: Enrich transaction ──────────────────────────────

function enrichTransaction(
  tx: TransactionRow,
  items: TransactionItemRow[]
): TransactionWithItems {
  const txOmzet = items.reduce((sum, item) => sum.plus(new D(item.line_omzet)), new D(0));
  const txLaba = items.reduce((sum, item) => sum.plus(new D(item.line_laba)), new D(0));
  const ongkir = new D(tx.ongkir);

  return {
    ...tx,
    items,
    total_omzet: toNumber(txOmzet),
    total_laba: toNumber(txLaba),
    amount_owed: toNumber(txOmzet.plus(ongkir)),
  };
}
