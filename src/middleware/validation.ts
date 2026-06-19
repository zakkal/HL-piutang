// ─── Validation Schemas (Zod) ─────────────────────────────────

import { z } from 'zod';

export const discountSchema = z.object({
  type: z.enum(['LM', 'BR'], { errorMap: () => ({ message: 'Tipe diskon harus LM atau BR' }) }),
  step_order: z.number().int().positive({ message: 'Urutan diskon harus bilangan positif' }),
  discount_percentage: z.number().min(0, 'Persentase diskon minimal 0').max(100, 'Persentase diskon maksimal 100'),
});

export const createCustomerSchema = z.object({
  name: z.string().min(1, 'Nama pelanggan wajib diisi').max(255, 'Nama terlalu panjang'),
  bonus_threshold: z.number().min(0, 'Target bonus tidak boleh negatif'),
  discounts: z.array(discountSchema).optional().default([]),
});

export const updateCustomerSchema = z.object({
  name: z.string().min(1, 'Nama pelanggan wajib diisi').max(255, 'Nama terlalu panjang').optional(),
  bonus_threshold: z.number().min(0, 'Target bonus tidak boleh negatif').optional(),
  discounts: z.array(discountSchema).optional(),
});

export const createProductSchema = z.object({
  name: z.string().min(1, 'Nama produk wajib diisi').max(255, 'Nama terlalu panjang'),
  type: z.enum(['LM', 'BR'], { errorMap: () => ({ message: 'Tipe produk harus LM atau BR' }) }),
  cost_price: z.number().min(0, 'Harga modal tidak boleh negatif'),
  base_price: z.number().min(0, 'Harga jual tidak boleh negatif'),
});

export const updateProductSchema = z.object({
  name: z.string().min(1, 'Nama produk wajib diisi').max(255, 'Nama terlalu panjang').optional(),
  type: z.enum(['LM', 'BR'], { errorMap: () => ({ message: 'Tipe produk harus LM atau BR' }) }).optional(),
  cost_price: z.number().min(0, 'Harga modal tidak boleh negatif').optional(),
  base_price: z.number().min(0, 'Harga jual tidak boleh negatif').optional(),
});

export const transactionLineSchema = z.object({
  product_id: z.string().uuid({ message: 'ID produk tidak valid' }),
  quantity: z.number().int().positive({ message: 'Jumlah item harus lebih dari 0' }),
});

export const createTransactionSchema = z.object({
  nomor_bon: z.string().min(1, 'Nomor bon wajib diisi').max(100, 'Nomor bon terlalu panjang'),
  customer_id: z.string().uuid({ message: 'Pelanggan tidak valid' }),
  tanggal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD'),
  items: z.array(transactionLineSchema).min(1, 'Minimal satu item produk harus diisi'),
  ongkir: z.number().min(0, 'Ongkir tidak boleh negatif').optional().default(0),
  deskripsi: z.string().optional().default(''),
  is_bonus: z.boolean().optional().default(false),
});

export const settleTransactionSchema = z.object({
  tanggal_pelunasan: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD'),
});

export const settleMonthSchema = z.object({
  month: z.number().int().min(1, 'Bulan tidak valid').max(12, 'Bulan tidak valid'),
  year: z.number().int().min(2000, 'Tahun tidak valid').max(2100, 'Tahun tidak valid'),
});

export const loginSchema = z.object({
  email: z.string().email({ message: 'Format email tidak valid' }),
  password: z.string().min(1, 'Password wajib diisi'),
});

export const recapQuerySchema = z.object({
  type: z.enum(['customer', 'product', 'overall'], {
    errorMap: () => ({ message: 'Tipe laporan harus customer, product, atau overall' }),
  }),
  month: z.string().regex(/^\d{1,2}$/, 'Bulan tidak valid').transform(Number),
  year: z.string().regex(/^\d{4}$/, 'Tahun tidak valid').transform(Number),
});

export const activityQuerySchema = z.object({
  month: z.string().regex(/^\d{1,2}$/, 'Bulan tidak valid').transform(Number),
  year: z.string().regex(/^\d{4}$/, 'Tahun tidak valid').transform(Number),
});
