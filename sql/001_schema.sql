-- ============================================================
-- HL Sales & Receivables Management App
-- Database Schema — PostgreSQL (Supabase)
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── customers ───────────────────────────────────────────────
CREATE TABLE public.customers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  bonus_threshold NUMERIC(15,2) NOT NULL DEFAULT 0,
  deleted_at  TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── customer_discounts ─────────────────────────────────────
CREATE TABLE public.customer_discounts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id         UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('LM', 'BR')),
  step_order          INTEGER NOT NULL CHECK (step_order > 0),
  discount_percentage NUMERIC(5,2) NOT NULL CHECK (discount_percentage >= 0 AND discount_percentage <= 100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (customer_id, type, step_order)
);

-- ─── products ────────────────────────────────────────────────
CREATE TABLE public.products (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  cost_price  NUMERIC(15,2) NOT NULL DEFAULT 0,
  base_price  NUMERIC(15,2) NOT NULL DEFAULT 0,
  type        TEXT NOT NULL CHECK (type IN ('LM', 'BR')),
  deleted_at  TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── transactions ────────────────────────────────────────────
CREATE TABLE public.transactions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nomor_bon           TEXT NOT NULL UNIQUE,
  customer_id         UUID NOT NULL REFERENCES public.customers(id),
  tanggal             DATE NOT NULL,
  tanggal_pelunasan   DATE NULL,
  ongkir              NUMERIC(15,2) NOT NULL DEFAULT 0,
  deskripsi           TEXT NOT NULL DEFAULT '',
  is_bonus            BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL DEFAULT 'Piutang' CHECK (status IN ('Piutang', 'Lunas')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── transaction_items ──────────────────────────────────────
CREATE TABLE public.transaction_items (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id          UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  product_id              UUID NOT NULL REFERENCES public.products(id),
  quantity                INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost_price         NUMERIC(15,2) NOT NULL DEFAULT 0,
  unit_discounted_price   NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_omzet              NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_laba               NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX idx_customers_name ON public.customers(name);
CREATE INDEX idx_transactions_customer ON public.transactions(customer_id);
CREATE INDEX idx_transactions_status ON public.transactions(status);
CREATE INDEX idx_transactions_tanggal ON public.transactions(tanggal);
CREATE INDEX idx_transaction_items_tx ON public.transaction_items(transaction_id);
CREATE INDEX idx_transaction_items_product ON public.transaction_items(product_id);

-- ─── Updated_at trigger ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customers_updated
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_products_updated
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_transactions_updated
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
