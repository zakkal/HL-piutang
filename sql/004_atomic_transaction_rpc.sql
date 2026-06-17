-- ============================================================
-- Atomic Transaction Creation RPC
-- Ensures transactions + items are saved atomically.
-- Called from Node.js backend via supabaseAdmin.rpc()
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_transaction_with_items(
  p_nomor_bon       TEXT,
  p_customer_id     UUID,
  p_tanggal         DATE,
  p_ongkir          NUMERIC(15,2),
  p_deskripsi       TEXT,
  p_is_bonus        BOOLEAN,
  p_items           JSONB,
  p_status          TEXT DEFAULT 'Piutang'
)
RETURNS UUID AS $$
DECLARE
  v_tx_id UUID;
  v_item  JSONB;
BEGIN
  -- Insert the transaction header
  INSERT INTO public.transactions (
    nomor_bon, customer_id, tanggal, ongkir, deskripsi, is_bonus, status
  ) VALUES (
    p_nomor_bon, p_customer_id, p_tanggal, p_ongkir, p_deskripsi, p_is_bonus, p_status
  ) RETURNING id INTO v_tx_id;

  -- Insert all items atomically
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) AS item
  LOOP
    INSERT INTO public.transaction_items (
      transaction_id, product_id, quantity,
      unit_cost_price, unit_discounted_price, line_omzet, line_laba
    ) VALUES (
      v_tx_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'quantity')::INTEGER,
      (v_item->>'unit_cost_price')::NUMERIC(15,2),
      (v_item->>'unit_discounted_price')::NUMERIC(15,2),
      (v_item->>'line_omzet')::NUMERIC(15,2),
      (v_item->>'line_laba')::NUMERIC(15,2)
    );
  END LOOP;

  RETURN v_tx_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to authenticated users (backend uses service_role which bypasses RLS)
GRANT EXECUTE ON FUNCTION public.create_transaction_with_items TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_transaction_with_items TO service_role;