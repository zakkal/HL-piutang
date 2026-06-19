-- ============================================================
-- Password History Table
-- Menyimpan hash SHA-256 dari password yang pernah digunakan
-- ============================================================

CREATE TABLE IF NOT EXISTS public.password_history (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL,
  pw_hash    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_history_user ON public.password_history(user_id);

-- RLS: hanya service role yang bisa akses
ALTER TABLE public.password_history ENABLE ROW LEVEL SECURITY;
