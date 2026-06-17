-- ============================================================
-- Row Level Security (RLS) Policies
-- Single-user internal app: only authenticated users can access
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_items ENABLE ROW LEVEL SECURITY;

-- ─── Authenticated user full access policies ────────────────
-- These policies allow any authenticated user (auth.uid() IS NOT NULL)
-- to perform CRUD. Since sign-up is disabled, only admin-created users
-- will ever exist.

-- customers
CREATE POLICY "Authenticated users can read customers"
  ON public.customers FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert customers"
  ON public.customers FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update customers"
  ON public.customers FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- customer_discounts
CREATE POLICY "Authenticated users can read customer_discounts"
  ON public.customer_discounts FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert customer_discounts"
  ON public.customer_discounts FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update customer_discounts"
  ON public.customer_discounts FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can delete customer_discounts"
  ON public.customer_discounts FOR DELETE
  TO authenticated USING (true);

-- products
CREATE POLICY "Authenticated users can read products"
  ON public.products FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert products"
  ON public.products FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update products"
  ON public.products FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- transactions
CREATE POLICY "Authenticated users can read transactions"
  ON public.transactions FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert transactions"
  ON public.transactions FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update transactions"
  ON public.transactions FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- transaction_items
CREATE POLICY "Authenticated users can read transaction_items"
  ON public.transaction_items FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert transaction_items"
  ON public.transaction_items FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update transaction_items"
  ON public.transaction_items FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- ─── Deny all access for anon (unauthenticated) ────────────
-- No policies for anon role = implicit deny
-- Anon users cannot SELECT, INSERT, UPDATE, or DELETE any rows
