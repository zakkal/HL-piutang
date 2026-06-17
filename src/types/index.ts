// ─── HL Sales & Receivables Management App — Type Definitions ──

export type ProductType = 'LM' | 'BR';
export type TransactionStatus = 'Piutang' | 'Lunas';

// ─── Database Row Types ────────────────────────────────────────

export interface CustomerRow {
  id: string;
  name: string;
  bonus_threshold: string; // NUMERIC comes as string from Postgres
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerDiscountRow {
  id: string;
  customer_id: string;
  type: ProductType;
  step_order: number;
  discount_percentage: string; // NUMERIC as string
  created_at: string;
}

export interface ProductRow {
  id: string;
  name: string;
  cost_price: string;
  base_price: string;
  type: ProductType;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransactionRow {
  id: string;
  nomor_bon: string;
  customer_id: string;
  tanggal: string;
  tanggal_pelunasan: string | null;
  ongkir: string;
  deskripsi: string;
  is_bonus: boolean;
  status: TransactionStatus;
  created_at: string;
  updated_at: string;
}

export interface TransactionItemRow {
  id: string;
  transaction_id: string;
  product_id: string;
  quantity: number;
  unit_cost_price: string;
  unit_discounted_price: string;
  line_omzet: string;
  line_laba: string;
  created_at: string;
}

// ─── API Request/Response Types ────────────────────────────────

export interface DiscountInput {
  type: ProductType;
  step_order: number;
  discount_percentage: number;
}

export interface CreateCustomerInput {
  name: string;
  bonus_threshold: number;
  discounts: DiscountInput[];
}

export interface UpdateCustomerInput {
  name?: string;
  bonus_threshold?: number;
  discounts?: DiscountInput[];
}

export interface CreateProductInput {
  name: string;
  type: ProductType;
  cost_price: number;
  base_price: number;
}

export interface UpdateProductInput {
  name?: string;
  type?: ProductType;
  cost_price?: number;
  base_price?: number;
}

export interface TransactionLineInput {
  product_id: string;
  quantity: number;
}

export interface CreateTransactionInput {
  nomor_bon: string;
  customer_id: string;
  tanggal: string; // ISO date string YYYY-MM-DD
  items: TransactionLineInput[];
  ongkir?: number;
  deskripsi?: string;
  is_bonus?: boolean;
}

export interface SettleTransactionInput {
  tanggal_pelunasan: string; // ISO date string
}

export interface SettleMonthInput {
  month: number;
  year: number;
}

// ─── Computed / Response Types ─────────────────────────────────

export interface CustomerWithDiscounts extends Omit<CustomerRow, 'bonus_threshold' | 'deleted_at'> {
  bonus_threshold: number;
  deleted_at: string | null;
  discounts: CustomerDiscountRow[];
  effective_discount_lm: number;
  effective_discount_br: number;
}

export interface TransactionWithItems extends TransactionRow {
  items: TransactionItemRow[];
  total_omzet: number;
  total_laba: number;
  amount_owed: number;
}

export interface CustomerActivitySummary {
  total_piutang: number;
  total_lunas: number;
  total_omzet_lm: number;
  total_omzet_br: number;
  total_omzet: number;
  total_laba_hl: number;
  transactions: TransactionWithItems[];
}

export interface BonusStatus {
  accumulated_paid_omzet: number;
  bonus_threshold: number;
  bonuses_earned: number;
  bonuses_already_granted: number;
  bonuses_remaining: number;
  carry_over_omzet: number;
}

export interface RecapEntry {
  id: string;
  name: string;
  total_omzet: number;
  total_omzet_lm: number;
  total_omzet_br: number;
  total_laba_hl: number;
  total_piutang: number;
  total_lunas: number;
}

export interface RecapReport {
  type: 'customer' | 'product' | 'overall';
  month: number;
  year: number;
  generated_at: string;
  entries: RecapEntry[];
  bonus_log: TransactionWithItems[];
  totals: {
    total_omzet: number;
    total_laba_hl: number;
    total_piutang: number;
    total_lunas: number;
  };
}
