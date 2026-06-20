# HL Sales — Backend

API server untuk aplikasi manajemen penjualan & piutang HL. Dibangun dengan Express + TypeScript + Supabase.

## Fitur
- REST API untuk pelanggan, produk, transaksi, laporan
- Kalkulasi diskon bertingkat (cascading discount)
- Sistem bonus pelanggan otomatis
- Rekap keuangan dengan export PDF
- AI endpoints via OpenRouter
- Autentikasi JWT via Supabase Auth

## Tech Stack
- Node.js + Express 5 + TypeScript
- Supabase (PostgreSQL + Auth)
- decimal.js (kalkulasi keuangan presisi)
- PDFKit (export PDF)
- OpenRouter (AI chat)

## Setup Lokal

```bash
npm install
cp .env.example .env
# Isi semua environment variables
npm run dev
```

## Environment Variables

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=google/gemma-4-31b-it:free
PORT=3001
NODE_ENV=development
SESSION_TIMEOUT_MINUTES=15
```

## Database Setup
Jalankan file SQL di folder `sql/` secara berurutan di Supabase SQL Editor:
1. `001_schema.sql`
2. `002_rls_policies.sql`
3. `003_server_functions.sql`
4. `004_atomic_transaction_rpc.sql`
5. `005_password_history.sql`
