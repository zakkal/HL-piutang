// ─── AI Service using Gemini API ────────────────────────────────
// Handles drafting payment reminders and answering business/financial queries.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { supabaseAdmin } from '../config/supabase';
import { toNumber, D } from './financial';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

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
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in backend .env');
  }

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

  // 3. Invoke Gemini
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
  const prompt = `\nAnda adalah asisten keuangan profesional untuk bisnis grosir/toko "HL".
Tugas Anda adalah membuat draf pesan pengingat pembayaran WhatsApp yang sangat sopan, ramah, dan profesional untuk pelanggan berikut:

Nama Pelanggan: ${customer.name}
Total Tunggakan: Rp ${totalOutstanding.toLocaleString('id-ID')}
Rincian Bon outstanding:
${outstandingDetails}

Aturan Penulisan Pesan:
1. Gunakan bahasa Indonesia yang sopan dan ramah (misalnya memakai sapaan "Bapak/Ibu", "Halo", "Semoga sehat selalu").
2. Sebutkan rincian nomor bon dan total nominal yang perlu dibayarkan dengan jelas.
3. Hindari kesan menuduh atau terlalu menekan. Fokus pada konfirmasi/mengingatkan status pembayaran.
4. Akhiri dengan ucapan terima kasih dan info kontak jika mereka ingin bertanya atau melakukan konfirmasi pembayaran.
5. HANYA kembalikan teks pesan WhatsApp yang siap dikirim (jangan berikan komentar pembuka/penutup asisten).
`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err: any) {
    if (err?.message?.includes('429') || err?.message?.includes('Too Many Requests') || err?.message?.includes('quota')) {
      throw new Error('Layanan AI sedang sibuk atau quota harian habis. Silakan coba lagi beberapa saat.');
    }
    throw err;
  }
}

/** Answer business questions based on live database snapshots */
export async function answerFinancialQuery(userQuery: string): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    return 'Mohon maaf, asisten AI belum bisa digunakan karena `GEMINI_API_KEY` belum dikonfigurasi di file .env backend.';
  }

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

  // 2. Format context for prompt
  const customerList = (customers || []).map(c => `- ${c.name} (Bonus Threshold: Rp ${Number(c.bonus_threshold).toLocaleString('id-ID')})`).join('\n');
  const productList = (products || []).map(p => `- ${p.name} (Tipe: ${p.type}, Jual: Rp ${Number(p.base_price).toLocaleString('id-ID')}, Modal: Rp ${Number(p.cost_price).toLocaleString('id-ID')})`).join('\n');
  
  const totalPiutang = transactions
    .filter(t => t.status === 'Piutang')
    .reduce((sum, t) => sum + t.amount_owed, 0);

  const totalLunasOmzet = transactions
    .filter(t => t.status === 'Lunas' && !t.is_bonus)
    .reduce((sum, t) => sum + t.total_omzet, 0);

  const totalLunasLaba = transactions
    .filter(t => t.status === 'Lunas' && !t.is_bonus)
    .reduce((sum, t) => sum + t.total_laba, 0);

  const txSummaries = transactions.slice(-15).map(t => 
    `- Bon: ${t.nomor_bon} | Pelanggan: ${t.customer_name} | Tanggal: ${t.tanggal} | Status: ${t.status} | Omzet: Rp ${t.total_omzet.toLocaleString('id-ID')} | Laba: Rp ${t.total_laba.toLocaleString('id-ID')} | Total Tagihan (incl ongkir): Rp ${t.amount_owed.toLocaleString('id-ID')}`
  ).join('\n');

  // 3. Invoke Gemini
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
  const prompt = `
Anda adalah "HL AI Assistant", asisten keuangan AI cerdas untuk pemilik bisnis "HL Sales".
Di bawah ini adalah data terbaru dari database toko Anda saat ini:

---
RINGKASAN KEUANGAN AKTIF:
- Total Piutang Belum Lunas: Rp ${totalPiutang.toLocaleString('id-ID')}
- Total Omzet Lunas (Cash Basis): Rp ${totalLunasOmzet.toLocaleString('id-ID')}
- Total Laba Bersih HL Lunas (Cash Basis): Rp ${totalLunasLaba.toLocaleString('id-ID')}

DAFTAR PELANGGAN AKTIF:
${customerList}

DAFTAR PRODUK CATALOG:
${productList}

DAFTAR 15 TRANSAKSI TERAKHIR:
${txSummaries}
---

Pertanyaan Pemilik Bisnis: "${userQuery}"

Tugas Anda:
1. Jawab pertanyaan di atas dengan ramah, jelas, profesional, dan akurat menggunakan data yang disediakan di atas.
2. Jika ditanya mengenai performa keuangan, prioritaskan metode "Cash Basis" (hanya menghitung transaksi berstatus Lunas untuk omzet/laba).
3. Jika data tidak tersedia di konteks di atas, beri tahu dengan sopan bahwa Anda saat ini tidak memiliki akses ke data spesifik tersebut.
4. Gunakan format daftar yang rapi (list) dengan spasi/baris baru agar mudah dibaca oleh pemilik toko.
5. Jawab dalam Bahasa Indonesia yang santun namun bersahabat.
6. Jika ditanya mengenai siapa yang menciptakan Anda atau siapa pembuat Anda, jawablah secara persis: "Saya diciptakan oleh pengguna HL".
7. JANGAN PERNAH menggunakan format tanda bintang ganda (seperti **teks**) atau tanda bintang tunggal (*) dalam jawaban Anda. Tuliskan teks biasa saja tanpa karakter bintang (*) sama sekali.
`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err: any) {
    if (err?.message?.includes('429') || err?.message?.includes('Too Many Requests') || err?.message?.includes('quota')) {
      return 'Maaf, layanan AI sedang tidak tersedia karena quota harian habis. Silakan coba lagi beberapa saat atau besok.';
    }
    throw err;
  }
}

// ─── Helper: handle Gemini quota errors ──────────────────────
function handleGeminiError(err: any): never {
  if (err?.message?.includes('429') || err?.message?.includes('Too Many Requests') || err?.message?.includes('quota')) {
    throw new Error('Layanan AI sedang sibuk atau quota harian habis. Silakan coba lagi beberapa saat.');
  }
  throw err;
}

// ─── 1. Analisis Risiko Piutang per Pelanggan ─────────────────
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

// ─── 5. Ringkasan Harian/Mingguan (AI-generated) ─────────────

export async function getDailySummary(): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY tidak dikonfigurasi');
  }

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];

  // Transaksi hari ini
  const { data: todayTxs } = await supabaseAdmin
    .from('transactions')
    .select('*, transaction_items(line_omzet, line_laba), customers(name)')
    .eq('tanggal', todayStr)
    .eq('is_bonus', false);

  // Transaksi minggu ini
  const { data: weekTxs } = await supabaseAdmin
    .from('transactions')
    .select('*, transaction_items(line_omzet, line_laba), customers(name)')
    .gte('tanggal', weekAgoStr)
    .lte('tanggal', todayStr)
    .eq('is_bonus', false);

  // Total piutang aktif
  const { data: allPiutang } = await supabaseAdmin
    .from('transactions')
    .select('ongkir, transaction_items(line_omzet), customers(name)')
    .eq('status', 'Piutang')
    .eq('is_bonus', false);

  // Overdue > 14 hari
  const overdueAlerts = await getOverdueAlerts(14);

  // Kalkulasi
  const todayNew = (todayTxs || []).length;
  const todayLunas = (todayTxs || []).filter((t: any) => t.status === 'Lunas').length;
  const todayPiutang = (todayTxs || []).filter((t: any) => t.status === 'Piutang').length;

  const weekOmzet = (weekTxs || [])
    .filter((t: any) => t.status === 'Lunas')
    .reduce((sum: number, t: any) => {
      return sum + (t.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_omzet || 0), 0);
    }, 0);

  const weekLaba = (weekTxs || [])
    .filter((t: any) => t.status === 'Lunas')
    .reduce((sum: number, t: any) => {
      return sum + (t.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_laba || 0), 0);
    }, 0);

  const totalPiutangAktif = (allPiutang || []).reduce((sum: number, t: any) => {
    const omzet = (t.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_omzet || 0), 0);
    return sum + omzet + Number(t.ongkir || 0);
  }, 0);

  const overdueCount = overdueAlerts.reduce((s, a) => s + a.overdueTransactions.length, 0);
  const overdueNames = overdueAlerts.slice(0, 3).map(a => a.customerName).join(', ');

  const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!).getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  const prompt = `
Anda adalah asisten bisnis "HL Sales". Buat ringkasan bisnis harian yang ringkas, informatif, dan mudah dibaca.
Format: gunakan emoji, teks biasa (TANPA markdown bintang **), dan baris baru antar poin.

Data hari ini (${todayStr}):
- Bon baru hari ini: ${todayNew} (${todayLunas} lunas, ${todayPiutang} piutang)
- Total piutang aktif: Rp ${totalPiutangAktif.toLocaleString('id-ID')}
- Omzet 7 hari terakhir (lunas): Rp ${weekOmzet.toLocaleString('id-ID')}
- Laba 7 hari terakhir (lunas): Rp ${weekLaba.toLocaleString('id-ID')}
- Bon overdue (>14 hari): ${overdueCount} bon
${overdueCount > 0 ? `- Pelanggan overdue teratas: ${overdueNames}` : ''}

Buat ringkasan 5-7 poin singkat mencakup: kondisi hari ini, piutang, performa minggu ini, dan peringatan jika ada overdue.
JANGAN gunakan tanda bintang (*) sama sekali. Gunakan emoji saja sebagai penanda poin.
`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err: any) {
    handleGeminiError(err);
  }
}
