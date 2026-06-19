// ─── AI Service — OpenRouter (no quota limit) ───────────────
// Chat & reminder pakai OpenRouter free tier (llama/mistral).
// Ringkasan harian pakai rule-based engine, tanpa AI call sama sekali.

import { supabaseAdmin } from '../config/supabase';
import { toNumber, D } from './financial';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ─── Helper: call OpenRouter ──────────────────────────────────
async function callOpenRouter(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY belum dikonfigurasi di .env');
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://hl-sales-app.railway.app',
      'X-Title': 'HL Sales App',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) {
      throw new Error('Layanan AI sedang sibuk. Silakan coba lagi beberapa saat.');
    }
    throw new Error(`OpenRouter error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json() as any;
  return json.choices?.[0]?.message?.content?.trim() || 'Tidak ada respons dari AI.';
}

/** Helper to enrich a list of transaction rows with their items */
async function getTransactionSummaries(): Promise<any[]> {
  const { data: txs, error } = await supabaseAdmin
    .from('transactions')
    .select('*, customers(name), transaction_items(line_omzet, line_laba)');

  if (error || !txs) return [];

  return txs.map((tx: any) => {
    const items = tx.transaction_items || [];
    const txOmzet = items.reduce((sum: number, item: any) => sum + Number(item.line_omzet || 0), 0);
    const txLaba = items.reduce((sum: number, item: any) => sum + Number(item.line_laba || 0), 0);
    const ongkir = Number(tx.ongkir || 0);

    return {
      id: tx.id,
      nomor_bon: tx.nomor_bon,
      tanggal: tx.tanggal,
      tanggal_pelunasan: tx.tanggal_pelunasan,
      customer_name: tx.customers?.name || 'Unknown',
      status: tx.status,
      is_bonus: tx.is_bonus,
      ongkir,
      total_omzet: txOmzet,
      total_laba: txLaba,
      amount_owed: txOmzet + ongkir,
    };
  });
}

/** Draft a polite WhatsApp payment reminder for outstanding transactions */
export async function generatePaymentReminder(
  customerId: string,
  transactionId?: string
): Promise<string> {
  // 1. Fetch customer name
  const { data: customer, error: custError } = await supabaseAdmin
    .from('customers')
    .select('name')
    .eq('id', customerId)
    .single();

  if (custError || !customer) {
    throw new Error('Customer not found');
  }

  // 2. Fetch outstanding transactions
  let query = supabaseAdmin
    .from('transactions')
    .select('*, transaction_items(line_omzet)')
    .eq('customer_id', customerId)
    .eq('status', 'Piutang');

  if (transactionId) {
    query = query.eq('id', transactionId);
  }

  const { data: txs, error: txError } = await query;
  if (txError || !txs || txs.length === 0) {
    throw new Error('No outstanding transactions found for this customer');
  }

  const outstandingDetails = txs.map((tx: any) => {
    const items = tx.transaction_items || [];
    const txOmzet = items.reduce((sum: number, item: any) => sum + Number(item.line_omzet || 0), 0);
    const ongkir = Number(tx.ongkir || 0);
    const total = txOmzet + ongkir;
    return `- Bon No: ${tx.nomor_bon} (Tanggal: ${tx.tanggal}) sebesar Rp ${total.toLocaleString('id-ID')} (termasuk ongkir Rp ${ongkir.toLocaleString('id-ID')})`;
  }).join('\n');

  const totalOutstanding = txs.reduce((sum: number, tx: any) => {
    const items = tx.transaction_items || [];
    const txOmzet = items.reduce((sum: number, item: any) => sum + Number(item.line_omzet || 0), 0);
    return sum + txOmzet + Number(tx.ongkir || 0);
  }, 0);

  // 3. Call OpenRouter
  const systemPrompt = `Anda adalah asisten keuangan profesional untuk bisnis grosir/toko "HL". Tugas Anda membuat draf pesan pengingat pembayaran WhatsApp yang sopan, ramah, dan profesional dalam Bahasa Indonesia. HANYA kembalikan teks pesan WhatsApp siap kirim, tanpa komentar tambahan.`;

  const userPrompt = `Buat draf pesan pengingat pembayaran untuk:
Nama Pelanggan: ${(customer as any).name}
Total Tunggakan: Rp ${totalOutstanding.toLocaleString('id-ID')}
Rincian Bon:
${outstandingDetails}

Aturan:
1. Gunakan sapaan sopan "Bapak/Ibu" dan salam pembuka hangat.
2. Sebutkan rincian nomor bon dan total dengan jelas.
3. Hindari kesan menuduh — fokus pada konfirmasi/pengingat.
4. Akhiri dengan terima kasih dan info kontak.
5. JANGAN gunakan tanda bintang (*) sama sekali.`;

  return callOpenRouter(systemPrompt, userPrompt);
}

/** Answer business questions based on live database snapshots */
export async function answerFinancialQuery(userQuery: string): Promise<string> {
  // 1. Fetch context data
  const { data: customers } = await supabaseAdmin
    .from('customers')
    .select('id, name, bonus_threshold')
    .is('deleted_at', null);

  const { data: products } = await supabaseAdmin
    .from('products')
    .select('id, name, type, cost_price, base_price')
    .is('deleted_at', null);

  const transactions = await getTransactionSummaries();

  // 2. Format context
  const customerList = (customers || []).map((c: any) => `- ${c.name} (Bonus Threshold: Rp ${Number(c.bonus_threshold).toLocaleString('id-ID')})`).join('\n');
  const productList = (products || []).map((p: any) => `- ${p.name} (Tipe: ${p.type}, Jual: Rp ${Number(p.base_price).toLocaleString('id-ID')}, Modal: Rp ${Number(p.cost_price).toLocaleString('id-ID')})`).join('\n');

  const totalPiutang = transactions.filter(t => t.status === 'Piutang').reduce((sum, t) => sum + t.amount_owed, 0);
  const totalLunasOmzet = transactions.filter(t => t.status === 'Lunas' && !t.is_bonus).reduce((sum, t) => sum + t.total_omzet, 0);
  const totalLunasLaba = transactions.filter(t => t.status === 'Lunas' && !t.is_bonus).reduce((sum, t) => sum + t.total_laba, 0);

  const txSummaries = transactions.slice(-15).map(t =>
    `- Bon: ${t.nomor_bon} | Pelanggan: ${t.customer_name} | Tanggal: ${t.tanggal} | Status: ${t.status} | Omzet: Rp ${t.total_omzet.toLocaleString('id-ID')} | Laba: Rp ${t.total_laba.toLocaleString('id-ID')} | Tagihan: Rp ${t.amount_owed.toLocaleString('id-ID')}`
  ).join('\n');

  // 3. Call OpenRouter
  const systemPrompt = `Anda adalah "HL AI Assistant", asisten keuangan cerdas untuk pemilik bisnis "HL Sales". Jawab dengan ramah, jelas, dan akurat dalam Bahasa Indonesia. Gunakan metode Cash Basis (hanya transaksi Lunas untuk omzet/laba). JANGAN gunakan tanda bintang (*) sama sekali. Jika ditanya siapa yang membuat Anda, jawab: "Saya diciptakan oleh pengguna HL".`;

  const userPrompt = `Data bisnis terkini:

RINGKASAN KEUANGAN:
- Total Piutang: Rp ${totalPiutang.toLocaleString('id-ID')}
- Total Omzet Lunas: Rp ${totalLunasOmzet.toLocaleString('id-ID')}
- Total Laba Bersih: Rp ${totalLunasLaba.toLocaleString('id-ID')}

PELANGGAN AKTIF:
${customerList || '(belum ada data)'}

PRODUK KATALOG:
${productList || '(belum ada data)'}

15 TRANSAKSI TERAKHIR:
${txSummaries || '(belum ada data)'}

Pertanyaan: ${userQuery}`;

  return callOpenRouter(systemPrompt, userPrompt);
}

// ─── Helper: handle Gemini quota errors ──────────────────────
function handleGeminiError(err: any): never {
  if (err?.message?.includes('429') || err?.message?.includes('Too Many Requests') || err?.message?.includes('quota')) {
    throw new Error('Layanan AI sedang sibuk atau quota harian habis. Silakan coba lagi beberapa saat.');
  }
  throw err;
}

// ─── 1. Analisis Risiko
// Menilai risiko macet berdasarkan histori pembayaran pelanggan

export interface RiskLevel {
  customerId: string;
  customerName: string;
  risk: 'low' | 'medium' | 'high';
  riskLabel: string;
  riskColor: string;
  totalPiutang: number;
  avgDaysToPay: number | null;
  overdueCount: number;
  summary: string;
}

export async function analyzeCustomerRisk(): Promise<RiskLevel[]> {
  // Fetch all active customers
  const { data: customers, error: custErr } = await supabaseAdmin
    .from('customers')
    .select('id, name')
    .is('deleted_at', null)
    .order('name');

  if (custErr || !customers) throw new Error('Gagal mengambil data pelanggan');

  // Fetch all transactions
  const { data: txs, error: txErr } = await supabaseAdmin
    .from('transactions')
    .select('id, customer_id, tanggal, tanggal_pelunasan, status, ongkir, transaction_items(line_omzet)');

  if (txErr || !txs) throw new Error('Gagal mengambil data transaksi');

  const today = new Date();

  const results: RiskLevel[] = customers.map((customer: any) => {
    const customerTxs = (txs as any[]).filter(t => t.customer_id === customer.id);
    const lunasTxs = customerTxs.filter(t => t.status === 'Lunas' && t.tanggal_pelunasan);
    const piutangTxs = customerTxs.filter(t => t.status === 'Piutang');

    // Total piutang saat ini
    const totalPiutang = piutangTxs.reduce((sum: number, t: any) => {
      const omzet = (t.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_omzet || 0), 0);
      return sum + omzet + Number(t.ongkir || 0);
    }, 0);

    // Rata-rata hari bayar dari transaksi lunas
    let avgDaysToPay: number | null = null;
    if (lunasTxs.length > 0) {
      const totalDays = lunasTxs.reduce((sum: number, t: any) => {
        const created = new Date(t.tanggal);
        const paid = new Date(t.tanggal_pelunasan);
        const diff = Math.max(0, (paid.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
        return sum + diff;
      }, 0);
      avgDaysToPay = Math.round(totalDays / lunasTxs.length);
    }

    // Hitung jumlah piutang yang sudah overdue (> 30 hari)
    const overdueCount = piutangTxs.filter((t: any) => {
      const created = new Date(t.tanggal);
      const diffDays = (today.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
      return diffDays > 30;
    }).length;

    // Tentukan level risiko
    let risk: 'low' | 'medium' | 'high' = 'low';

    if (overdueCount >= 3 || (avgDaysToPay !== null && avgDaysToPay > 45) || (totalPiutang > 0 && overdueCount >= 2)) {
      risk = 'high';
    } else if (overdueCount >= 1 || (avgDaysToPay !== null && avgDaysToPay > 20) || totalPiutang > 5000000) {
      risk = 'medium';
    }

    const riskLabel = risk === 'high' ? 'Risiko Tinggi' : risk === 'medium' ? 'Perlu Perhatian' : 'Aman';
    const riskColor = risk === 'high' ? 'red' : risk === 'medium' ? 'yellow' : 'green';

    let summary = '';
    if (risk === 'high') {
      summary = `${overdueCount} bon overdue >30 hari${avgDaysToPay ? `, rata-rata bayar ${avgDaysToPay} hari` : ''}.`;
    } else if (risk === 'medium') {
      summary = `${overdueCount > 0 ? `${overdueCount} bon overdue. ` : ''}${avgDaysToPay ? `Rata-rata bayar ${avgDaysToPay} hari.` : 'Piutang cukup besar.'}`;
    } else {
      summary = avgDaysToPay !== null ? `Rata-rata bayar ${avgDaysToPay} hari. Baik.` : 'Belum ada histori pembayaran.';
    }

    return { customerId: customer.id, customerName: customer.name, risk, riskLabel, riskColor, totalPiutang, avgDaysToPay, overdueCount, summary };
  });

  return results;
}

// ─── 2. Prediksi Kapan Pelanggan Akan Bayar ──────────────────

export interface PaymentPrediction {
  customerId: string;
  customerName: string;
  avgDaysToPay: number | null;
  estimatedPayDate: string | null;
  totalPiutang: number;
  piutangCount: number;
  confidence: 'high' | 'medium' | 'low' | 'none';
}

export async function predictPayments(): Promise<PaymentPrediction[]> {
  const { data: customers } = await supabaseAdmin
    .from('customers')
    .select('id, name')
    .is('deleted_at', null)
    .order('name');

  const { data: txs } = await supabaseAdmin
    .from('transactions')
    .select('id, customer_id, tanggal, tanggal_pelunasan, status, ongkir, transaction_items(line_omzet)');

  if (!customers || !txs) return [];

  const today = new Date();

  return (customers as any[]).map((customer: any) => {
    const customerTxs = (txs as any[]).filter(t => t.customer_id === customer.id);
    const lunasTxs = customerTxs.filter(t => t.status === 'Lunas' && t.tanggal_pelunasan);
    const piutangTxs = customerTxs.filter(t => t.status === 'Piutang');

    const totalPiutang = piutangTxs.reduce((sum: number, t: any) => {
      const omzet = (t.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_omzet || 0), 0);
      return sum + omzet + Number(t.ongkir || 0);
    }, 0);

    let avgDaysToPay: number | null = null;
    let estimatedPayDate: string | null = null;
    let confidence: 'high' | 'medium' | 'low' | 'none' = 'none';

    if (lunasTxs.length >= 3) {
      // Ambil 5 transaksi lunas terakhir untuk prediksi lebih akurat
      const recentLunas = [...lunasTxs]
        .sort((a: any, b: any) => new Date(b.tanggal_pelunasan).getTime() - new Date(a.tanggal_pelunasan).getTime())
        .slice(0, 5);

      const totalDays = recentLunas.reduce((sum: number, t: any) => {
        const diff = (new Date(t.tanggal_pelunasan).getTime() - new Date(t.tanggal).getTime()) / (1000 * 60 * 60 * 24);
        return sum + Math.max(0, diff);
      }, 0);

      avgDaysToPay = Math.round(totalDays / recentLunas.length);
      confidence = lunasTxs.length >= 5 ? 'high' : 'medium';

      if (piutangTxs.length > 0) {
        // Prediksi berdasarkan bon piutang tertua
        const oldestPiutang = [...piutangTxs].sort((a: any, b: any) =>
          new Date(a.tanggal).getTime() - new Date(b.tanggal).getTime()
        )[0];
        const estDate = new Date(oldestPiutang.tanggal);
        estDate.setDate(estDate.getDate() + avgDaysToPay);
        estimatedPayDate = estDate.toISOString().split('T')[0];
      }
    } else if (lunasTxs.length > 0) {
      const totalDays = lunasTxs.reduce((sum: number, t: any) => {
        const diff = (new Date(t.tanggal_pelunasan).getTime() - new Date(t.tanggal).getTime()) / (1000 * 60 * 60 * 24);
        return sum + Math.max(0, diff);
      }, 0);
      avgDaysToPay = Math.round(totalDays / lunasTxs.length);
      confidence = 'low';

      if (piutangTxs.length > 0) {
        const oldestPiutang = [...piutangTxs].sort((a: any, b: any) =>
          new Date(a.tanggal).getTime() - new Date(b.tanggal).getTime()
        )[0];
        const estDate = new Date(oldestPiutang.tanggal);
        estDate.setDate(estDate.getDate() + avgDaysToPay);
        estimatedPayDate = estDate.toISOString().split('T')[0];
      }
    }

    return {
      customerId: customer.id,
      customerName: customer.name,
      avgDaysToPay,
      estimatedPayDate,
      totalPiutang,
      piutangCount: piutangTxs.length,
      confidence,
    };
  }).filter((p: PaymentPrediction) => p.piutangCount > 0 || p.avgDaysToPay !== null);
}

// ─── 3. Auto-detect overdue & siapkan bulk reminders ─────────

export interface OverdueSummary {
  customerId: string;
  customerName: string;
  overdueTransactions: Array<{
    id: string;
    nomor_bon: string;
    tanggal: string;
    daysOverdue: number;
    amountOwed: number;
  }>;
  totalOverdue: number;
}

export async function getOverdueAlerts(thresholdDays = 14): Promise<OverdueSummary[]> {
  const { data: txs } = await supabaseAdmin
    .from('transactions')
    .select('id, customer_id, nomor_bon, tanggal, status, ongkir, transaction_items(line_omzet), customers(name)')
    .eq('status', 'Piutang')
    .eq('is_bonus', false);

  if (!txs) return [];

  const today = new Date();
  const overdueMap = new Map<string, OverdueSummary>();

  for (const tx of txs as any[]) {
    const created = new Date(tx.tanggal);
    const daysOverdue = Math.floor((today.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));

    if (daysOverdue < thresholdDays) continue;

    const omzet = (tx.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_omzet || 0), 0);
    const amountOwed = omzet + Number(tx.ongkir || 0);
    const customerName = tx.customers?.name || 'Unknown';

    if (!overdueMap.has(tx.customer_id)) {
      overdueMap.set(tx.customer_id, {
        customerId: tx.customer_id,
        customerName,
        overdueTransactions: [],
        totalOverdue: 0,
      });
    }

    const entry = overdueMap.get(tx.customer_id)!;
    entry.overdueTransactions.push({ id: tx.id, nomor_bon: tx.nomor_bon, tanggal: tx.tanggal, daysOverdue, amountOwed });
    entry.totalOverdue += amountOwed;
  }

  return Array.from(overdueMap.values())
    .sort((a, b) => b.totalOverdue - a.totalOverdue);
}

// ─── 4. Deteksi Anomali Transaksi ─────────────────────────────

export interface TransactionAnomaly {
  transactionId: string;
  nomor_bon: string;
  customerName: string;
  tanggal: string;
  amountOwed: number;
  anomalyType: string;
  description: string;
  severity: 'warning' | 'info';
}

export async function detectAnomalies(): Promise<TransactionAnomaly[]> {
  const { data: txs } = await supabaseAdmin
    .from('transactions')
    .select('id, customer_id, nomor_bon, tanggal, status, ongkir, is_bonus, transaction_items(line_omzet), customers(name)')
    .order('tanggal', { ascending: false })
    .limit(200);

  if (!txs) return [];

  const anomalies: TransactionAnomaly[] = [];

  // Hitung rata-rata nilai transaksi per pelanggan
  const customerAvgMap = new Map<string, { total: number; count: number }>();
  for (const tx of txs as any[]) {
    if (tx.is_bonus) continue;
    const omzet = (tx.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_omzet || 0), 0);
    const amount = omzet + Number(tx.ongkir || 0);
    const existing = customerAvgMap.get(tx.customer_id) || { total: 0, count: 0 };
    customerAvgMap.set(tx.customer_id, { total: existing.total + amount, count: existing.count + 1 });
  }

  // Deteksi anomali
  for (const tx of txs as any[]) {
    const omzet = (tx.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_omzet || 0), 0);
    const amountOwed = omzet + Number(tx.ongkir || 0);
    const customerName = (tx as any).customers?.name || 'Unknown';

    // Anomali 1: Nilai jauh di atas rata-rata (>3x avg)
    if (!tx.is_bonus) {
      const avg = customerAvgMap.get(tx.customer_id);
      if (avg && avg.count >= 3) {
        const customerAvg = avg.total / avg.count;
        if (amountOwed > customerAvg * 3 && amountOwed > 1000000) {
          anomalies.push({
            transactionId: tx.id,
            nomor_bon: tx.nomor_bon,
            customerName,
            tanggal: tx.tanggal,
            amountOwed,
            anomalyType: 'Nilai Tidak Wajar',
            description: `Nilai Rp ${amountOwed.toLocaleString('id-ID')} adalah ${Math.round(amountOwed / customerAvg)}x di atas rata-rata pelanggan ini (Rp ${Math.round(customerAvg).toLocaleString('id-ID')}).`,
            severity: 'warning',
          });
        }
      }
    }

    // Anomali 2: Ongkir sangat besar (>50% dari total)
    const ongkir = Number(tx.ongkir || 0);
    if (!tx.is_bonus && ongkir > 0 && omzet > 0 && ongkir / omzet > 0.5) {
      anomalies.push({
        transactionId: tx.id,
        nomor_bon: tx.nomor_bon,
        customerName,
        tanggal: tx.tanggal,
        amountOwed,
        anomalyType: 'Ongkir Tidak Wajar',
        description: `Ongkir Rp ${ongkir.toLocaleString('id-ID')} adalah ${Math.round((ongkir / omzet) * 100)}% dari nilai omzet — tidak lazim.`,
        severity: 'warning',
      });
    }
  }

  // Batasi 20 anomali terbaru
  return anomalies.slice(0, 20);
}

// ─── 5. Ringkasan Harian (Rule-Based, tanpa AI/quota) ─────────
// Generate teks ringkasan bisnis yang detail dari data real
// tanpa memanggil Gemini — tidak ada limit, selalu tersedia.

export async function getDailySummary(): Promise<string> {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];

  const monthAgo = new Date(today);
  monthAgo.setDate(monthAgo.getDate() - 30);
  const monthAgoStr = monthAgo.toISOString().split('T')[0];

  const fmt = (n: number) => n.toLocaleString('id-ID');
  const fmtRp = (n: number) => `Rp ${fmt(n)}`;

  // ── Fetch semua data yang dibutuhkan ──────────────────────
  const [todayTxsRes, weekTxsRes, monthTxsRes, allPiutangRes, allCustomersRes] = await Promise.all([
    supabaseAdmin.from('transactions').select('*, transaction_items(line_omzet, line_laba), customers(name)').eq('tanggal', todayStr).eq('is_bonus', false),
    supabaseAdmin.from('transactions').select('*, transaction_items(line_omzet, line_laba), customers(name)').gte('tanggal', weekAgoStr).lte('tanggal', todayStr).eq('is_bonus', false),
    supabaseAdmin.from('transactions').select('*, transaction_items(line_omzet, line_laba), customers(name)').gte('tanggal', monthAgoStr).lte('tanggal', todayStr).eq('is_bonus', false),
    supabaseAdmin.from('transactions').select('customer_id, ongkir, transaction_items(line_omzet), customers(name)').eq('status', 'Piutang').eq('is_bonus', false),
    supabaseAdmin.from('customers').select('id, name').is('deleted_at', null),
  ]);

  const todayTxs = todayTxsRes.data || [];
  const weekTxs = weekTxsRes.data || [];
  const monthTxs = monthTxsRes.data || [];
  const allPiutang = allPiutangRes.data || [];
  const allCustomers = allCustomersRes.data || [];

  // ── Kalkulasi hari ini ────────────────────────────────────
  const todayNew = todayTxs.length;
  const todayLunas = todayTxs.filter((t: any) => t.status === 'Lunas');
  const todayPiutangTxs = todayTxs.filter((t: any) => t.status === 'Piutang');
  const todayOmzet = todayLunas.reduce((s: number, t: any) =>
    s + (t.transaction_items || []).reduce((ss: number, i: any) => ss + Number(i.line_omzet || 0), 0), 0);
  const todayLaba = todayLunas.reduce((s: number, t: any) =>
    s + (t.transaction_items || []).reduce((ss: number, i: any) => ss + Number(i.line_laba || 0), 0), 0);

  // ── Kalkulasi minggu ini ──────────────────────────────────
  const weekLunasTxs = weekTxs.filter((t: any) => t.status === 'Lunas');
  const weekOmzet = weekLunasTxs.reduce((s: number, t: any) =>
    s + (t.transaction_items || []).reduce((ss: number, i: any) => ss + Number(i.line_omzet || 0), 0), 0);
  const weekLaba = weekLunasTxs.reduce((s: number, t: any) =>
    s + (t.transaction_items || []).reduce((ss: number, i: any) => ss + Number(i.line_laba || 0), 0), 0);
  const weekNewTxCount = weekTxs.length;

  // ── Kalkulasi 30 hari ─────────────────────────────────────
  const monthLunasTxs = monthTxs.filter((t: any) => t.status === 'Lunas');
  const monthOmzet = monthLunasTxs.reduce((s: number, t: any) =>
    s + (t.transaction_items || []).reduce((ss: number, i: any) => ss + Number(i.line_omzet || 0), 0), 0);
  const monthLaba = monthLunasTxs.reduce((s: number, t: any) =>
    s + (t.transaction_items || []).reduce((ss: number, i: any) => ss + Number(i.line_laba || 0), 0), 0);

  // ── Kalkulasi piutang aktif ───────────────────────────────
  const totalPiutangAktif = allPiutang.reduce((s: number, t: any) => {
    const omzet = (t.transaction_items || []).reduce((ss: number, i: any) => ss + Number(i.line_omzet || 0), 0);
    return s + omzet + Number(t.ongkir || 0);
  }, 0);

  // Piutang per pelanggan
  const piutangPerCustomer = new Map<string, { name: string; total: number; count: number }>();
  for (const t of allPiutang as any[]) {
    const cid = t.customer_id;
    const omzet = (t.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_omzet || 0), 0);
    const amount = omzet + Number(t.ongkir || 0);
    const name = t.customers?.name || 'Unknown';
    if (!piutangPerCustomer.has(cid)) piutangPerCustomer.set(cid, { name, total: 0, count: 0 });
    const entry = piutangPerCustomer.get(cid)!;
    entry.total += amount;
    entry.count += 1;
  }
  const topPiutangCustomers = Array.from(piutangPerCustomer.values())
    .sort((a, b) => b.total - a.total).slice(0, 3);

  // ── Overdue > 14 hari ─────────────────────────────────────
  const overdueAlerts = await getOverdueAlerts(14);
  const overdueCount = overdueAlerts.reduce((s, a) => s + a.overdueTransactions.length, 0);
  const overdueTotalValue = overdueAlerts.reduce((s, a) => s + a.totalOverdue, 0);

  // ── Overdue > 30 hari (kritis) ────────────────────────────
  const criticalOverdue = await getOverdueAlerts(30);
  const criticalCount = criticalOverdue.reduce((s, a) => s + a.overdueTransactions.length, 0);

  // ── Margin laba ───────────────────────────────────────────
  const weekMargin = weekOmzet > 0 ? ((weekLaba / weekOmzet) * 100).toFixed(1) : '0';
  const monthMargin = monthOmzet > 0 ? ((monthLaba / monthOmzet) * 100).toFixed(1) : '0';

  // ── Tingkat pelunasan minggu ini ──────────────────────────
  const weekTotal = weekTxs.length;
  const weekLunasCount = weekLunasTxs.length;
  const lunasRate = weekTotal > 0 ? ((weekLunasCount / weekTotal) * 100).toFixed(0) : '0';

  // ── Generate teks ringkasan ───────────────────────────────
  const todayDate = today.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const lines: string[] = [];

  lines.push(`📋 Laporan Bisnis Harian — ${todayDate}`);
  lines.push('');

  // Kondisi hari ini
  lines.push('📌 Kondisi Hari Ini');
  if (todayNew === 0) {
    lines.push('Belum ada transaksi baru yang tercatat hari ini.');
  } else {
    lines.push(`Tercatat ${todayNew} transaksi baru hari ini — ${todayLunas.length} langsung lunas, ${todayPiutangTxs.length} masih piutang.`);
    if (todayOmzet > 0) lines.push(`Omzet terkonfirmasi hari ini: ${fmtRp(todayOmzet)} dengan laba bersih ${fmtRp(todayLaba)}.`);
  }
  lines.push('');

  // Piutang aktif
  lines.push('💰 Status Piutang Aktif');
  if (totalPiutangAktif === 0) {
    lines.push('Tidak ada piutang aktif saat ini. Semua pembayaran telah lunas.');
  } else {
    lines.push(`Total piutang yang belum terkumpul: ${fmtRp(totalPiutangAktif)} dari ${allPiutang.length} bon aktif.`);
    if (topPiutangCustomers.length > 0) {
      lines.push(`Piutang terbesar saat ini:`);
      topPiutangCustomers.forEach((c, idx) => {
        lines.push(`  ${idx + 1}. ${c.name} — ${fmtRp(c.total)} (${c.count} bon)`);
      });
    }
  }
  lines.push('');

  // Performa 7 hari
  lines.push('📈 Performa 7 Hari Terakhir');
  if (weekOmzet === 0) {
    lines.push('Belum ada omzet terkonfirmasi dalam 7 hari terakhir.');
  } else {
    lines.push(`Omzet lunas: ${fmtRp(weekOmzet)} dari ${weekLunasCount} transaksi.`);
    lines.push(`Laba bersih HL: ${fmtRp(weekLaba)} (margin ${weekMargin}%).`);
    lines.push(`Tingkat pelunasan minggu ini: ${lunasRate}% dari ${weekTotal} total transaksi.`);
  }
  lines.push('');

  // Performa 30 hari
  lines.push('📊 Performa 30 Hari Terakhir');
  if (monthOmzet === 0) {
    lines.push('Belum ada data omzet 30 hari terakhir.');
  } else {
    lines.push(`Omzet lunas: ${fmtRp(monthOmzet)} — Laba bersih: ${fmtRp(monthLaba)} (margin ${monthMargin}%).`);
    lines.push(`Rata-rata omzet per hari: ${fmtRp(Math.round(monthOmzet / 30))}.`);
  }
  lines.push('');

  // Peringatan overdue
  if (overdueCount === 0) {
    lines.push('✅ Status Pembayaran');
    lines.push('Tidak ada bon yang melewati batas waktu wajar (>14 hari). Kondisi pembayaran pelanggan sangat baik.');
  } else {
    lines.push('⚠️ Peringatan Overdue');
    lines.push(`Terdapat ${overdueCount} bon belum lunas lebih dari 14 hari, senilai total ${fmtRp(overdueTotalValue)}.`);
    if (criticalCount > 0) {
      lines.push(`Dari jumlah tersebut, ${criticalCount} bon sudah melewati 30 hari dan membutuhkan tindakan segera.`);
    }
    const topOverdue = overdueAlerts.slice(0, 2);
    if (topOverdue.length > 0) {
      lines.push(`Prioritas penagihan:`);
      topOverdue.forEach((a, idx) => {
        lines.push(`  ${idx + 1}. ${a.customerName} — ${fmtRp(a.totalOverdue)} (${a.overdueTransactions.length} bon, terlama ${a.overdueTransactions[0]?.daysOverdue} hari)`);
      });
    }
  }
  lines.push('');

  // Rekomendasi
  lines.push('💡 Rekomendasi Hari Ini');
  const recs: string[] = [];
  if (criticalCount > 0) recs.push(`Segera hubungi pelanggan dengan bon overdue >30 hari untuk memastikan kepastian pembayaran.`);
  if (overdueCount > 0 && criticalCount === 0) recs.push(`Kirimkan pengingat pembayaran via WhatsApp kepada pelanggan dengan bon overdue.`);
  if (totalPiutangAktif > monthOmzet * 0.5) recs.push(`Rasio piutang terhadap omzet bulan ini cukup tinggi — pertimbangkan untuk memprioritaskan pelunasan sebelum menambah bon baru.`);
  if (weekMargin !== '0' && parseFloat(weekMargin) < 10) recs.push(`Margin laba minggu ini di bawah 10% — tinjau kembali struktur diskon pelanggan.`);
  if (recs.length === 0) recs.push(`Kondisi bisnis berjalan baik. Pertahankan disiplin pencatatan dan follow-up piutang secara rutin.`);
  recs.forEach((r, i) => lines.push(`${i + 1}. ${r}`));

  return lines.join('\n');
}
