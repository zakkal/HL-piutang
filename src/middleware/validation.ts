// ─── Validation Schemas (Zod) ─────────────────────────────────

import { z } from 'zod';

export const discountSchema = z.object({
  type: z.enum(['LM', 'BR']),
  step_order: z.number().int().positive(),
  discount_percentage: z.number().min(0).max(100),
});

export const createCustomerSchema = z.object({
  name: z.string().min(1).max(255),
  bonus_threshold: z.number().min(0),
  discounts: z.array(discountSchema).optional().default([]),
});

export const updateCustomerSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  bonus_threshold: z.number().min(0).optional(),
  discounts: z.array(discountSchema).optional(),
});

export const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['LM', 'BR']),
  cost_price: z.number().min(0),
  base_price: z.number().min(0),
});

export const updateProductSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.enum(['LM', 'BR']).optional(),
  cost_price: z.number().min(0).optional(),
  base_price: z.number().min(0).optional(),
});

export const transactionLineSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
});

export const createTransactionSchema = z.object({
  nomor_bon: z.string().min(1).max(100),
  customer_id: z.string().uuid(),
  tanggal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  items: z.array(transactionLineSchema).min(1, 'At least one item is required'),
  ongkir: z.number().min(0).optional().default(0),
  deskripsi: z.string().optional().default(''),
  is_bonus: z.boolean().optional().default(false),
});

export const settleTransactionSchema = z.object({
  tanggal_pelunasan: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
});

export const settleMonthSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const recapQuerySchema = z.object({
  type: z.enum(['customer', 'product', 'overall']),
  month: z.string().regex(/^\d{1,2}$/).transform(Number),
  year: z.string().regex(/^\d{4}$/).transform(Number),
});

export const activityQuerySchema = z.object({
  month: z.string().regex(/^\d{1,2}$/).transform(Number),
  year: z.string().regex(/^\d{4}$/).transform(Number),
});
