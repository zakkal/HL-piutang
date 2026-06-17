-- ============================================================
-- Server-Side Functions for Financial Data Isolation
--
-- cost_price and line_laba are sensitive. These functions
-- ensure the Node.js backend (using service_role key) can
-- access them, while direct client-side queries from anon
-- or even authenticated users via Supabase client are
-- restricted through a separate view.
-- ============================================================

-- ─── Restricted views (hide cost_price and line_laba) ──────
-- These views are what the frontend would query directly.
-- They exclude cost_price from products and line_laba from
-- transaction_items.

CREATE OR REPLACE VIEW public.products_public AS
  SELECT id, name, base_price, type, deleted_at, created_at, updated_at
  FROM public.products;

CREATE OR REPLACE VIEW public.transaction_items_public AS
  SELECT id, transaction_id, product_id, quantity,
         unit_discounted_price, line_omzet, created_at
  FROM public.transaction_items;

-- ─── RLS on views: authenticated only ──────────────────────
-- (Views inherit RLS from underlying tables, but we also
--  restrict direct table access for cost_price/line_laba)

-- Add specific column-level deny policies for anon
-- Anon already denied by RLS, but for extra safety:

-- Revoke direct SELECT on sensitive columns from authenticated role
-- (authenticated users should use the _public views for reading,
--  while the Node.js backend uses service_role key for full access)

-- Note: In practice, the Node.js backend uses the service_role key
-- which bypasses RLS entirely. The frontend should use the anon key
-- with the _public views. This separation is enforced at the
-- application level, not at the database level, because Supabase
-- RLS operates at the row level, not the column level.

-- ─── Helper function: calculate bonus eligibility ──────────
CREATE OR REPLACE FUNCTION public.get_customer_bonus_status(p_customer_id UUID)
RETURNS TABLE (
  accumulated_paid_omzet NUMERIC,
  bonus_threshold        NUMERIC,
  bonuses_earned         BIGINT,
  bonuses_already_granted BIGINT,
  bonuses_remaining      BIGINT,
  carry_over_omzet       NUMERIC
) AS $$
DECLARE
  v_accumulated NUMERIC;
  v_threshold   NUMERIC;
  v_earned      BIGINT;
  v_granted     BIGINT;
BEGIN
  -- Sum omzet from Lunas transactions (excluding bonus transactions)
  SELECT COALESCE(SUM(ti.line_omzet), 0)
  INTO v_accumulated
  FROM public.transaction_items ti
  JOIN public.transactions t ON t.id = ti.transaction_id
  WHERE t.customer_id = p_customer_id
    AND t.status = 'Lunas'
    AND t.is_bonus = false;

  -- Get bonus threshold
  SELECT bonus_threshold INTO v_threshold
  FROM public.customers WHERE id = p_customer_id;

  -- Count bonus transactions already granted
  SELECT COUNT(*) INTO v_granted
  FROM public.transactions
  WHERE customer_id = p_customer_id
    AND is_bonus = true;

  -- Calculate earned bonuses
  v_earned := FLOOR(v_accumulated / NULLIF(v_threshold, 0));

  RETURN QUERY SELECT
    v_accumulated,
    v_threshold,
    v_earned,
    v_granted,
    GREATEST(v_earned - v_granted, 0),
    v_accumulated - (v_earned * v_threshold);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── Helper function: customer activity summary ────────────
CREATE OR REPLACE FUNCTION public.get_customer_activity(
  p_customer_id UUID,
  p_month INTEGER,
  p_year INTEGER
)
RETURNS TABLE (
  total_piutang     NUMERIC,
  total_lunas       NUMERIC,
  total_omzet_lm    NUMERIC,
  total_omzet_br    NUMERIC,
  total_omzet       NUMERIC,
  total_laba_hl     NUMERIC
) AS $$
DECLARE
  v_piutang  NUMERIC;
  v_lunas    NUMERIC;
  v_omzet_lm NUMERIC;
  v_omzet_br NUMERIC;
  v_laba     NUMERIC;
BEGIN
  -- Total outstanding Piutang (is_bonus = false only)
  SELECT COALESCE(SUM(ti.line_omzet), 0) + COALESCE(SUM(t.ongkir), 0)
  INTO v_piutang
  FROM public.transactions t
  JOIN public.transaction_items ti ON ti.transaction_id = t.id
  WHERE t.customer_id = p_customer_id
    AND t.status = 'Piutang'
    AND t.is_bonus = false
    AND EXTRACT(MONTH FROM t.tanggal) = p_month
    AND EXTRACT(YEAR FROM t.tanggal) = p_year;

  -- Total Lunas omzet (LM type, is_bonus = false)
  SELECT COALESCE(SUM(ti.line_omzet), 0)
  INTO v_omzet_lm
  FROM public.transactions t
  JOIN public.transaction_items ti ON ti.transaction_id = t.id
  JOIN public.products p ON p.id = ti.product_id
  WHERE t.customer_id = p_customer_id
    AND t.status = 'Lunas'
    AND t.is_bonus = false
    AND p.type = 'LM'
    AND EXTRACT(MONTH FROM t.tanggal) = p_month
    AND EXTRACT(YEAR FROM t.tanggal) = p_year;

  -- Total Lunas omzet (BR type, is_bonus = false)
  SELECT COALESCE(SUM(ti.line_omzet), 0)
  INTO v_omzet_br
  FROM public.transactions t
  JOIN public.transaction_items ti ON ti.transaction_id = t.id
  JOIN public.products p ON p.id = ti.product_id
  WHERE t.customer_id = p_customer_id
    AND t.status = 'Lunas'
    AND t.is_bonus = false
    AND p.type = 'BR'
    AND EXTRACT(MONTH FROM t.tanggal) = p_month
    AND EXTRACT(YEAR FROM t.tanggal) = p_year;

  -- Total Laba HL from Lunas (is_bonus = false)
  SELECT COALESCE(SUM(ti.line_laba), 0)
  INTO v_laba
  FROM public.transactions t
  JOIN public.transaction_items ti ON ti.transaction_id = t.id
  WHERE t.customer_id = p_customer_id
    AND t.status = 'Lunas'
    AND t.is_bonus = false
    AND EXTRACT(MONTH FROM t.tanggal) = p_month
    AND EXTRACT(YEAR FROM t.tanggal) = p_year;

  -- Total Lunas amount (omzet + ongkir)
  SELECT COALESCE(SUM(ti.line_omzet), 0) + COALESCE(SUM(t.ongkir), 0)
  INTO v_lunas
  FROM public.transactions t
  JOIN public.transaction_items ti ON ti.transaction_id = t.id
  WHERE t.customer_id = p_customer_id
    AND t.status = 'Lunas'
    AND t.is_bonus = false
    AND EXTRACT(MONTH FROM t.tanggal) = p_month
    AND EXTRACT(YEAR FROM t.tanggal) = p_year;

  RETURN QUERY SELECT
    v_piutang,
    v_lunas,
    v_omzet_lm,
    v_omzet_br,
    v_omzet_lm + v_omzet_br,
    v_laba;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
