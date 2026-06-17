// ─── Report Service ────────────────────────────────────────────
// Generates recaps and PDF exports.
// Cash Basis: Only Lunas non-bonus transactions count toward financial metrics.
// Bonus transactions are logged separately.

import { supabaseAdmin } from '../config/supabase';
import { toDecimal, toNumber, D } from './financial';
import type {
  RecapReport,
  RecapEntry,
  TransactionWithItems,
  TransactionRow,
  TransactionItemRow,
} from '../types';

// ─── Recap Report ──────────────────────────────────────────────

export async function getRecap(
  type: 'customer' | 'product' | 'overall',
  month: number,
  year: number
): Promise<RecapReport> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  // Calculate actual last day of the month
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // Fetch all Lunas non-bonus transactions for the period
  const { data: lunasTxs, error: lunasError } = await supabaseAdmin
    .from('transactions')
    .select('*, transaction_items(*)')
    .eq('status', 'Lunas')
    .eq('is_bonus', false)
    .gte('tanggal', startDate)
    .lte('tanggal', endDate);

  if (lunasError) throw new Error(`Failed to fetch transactions: ${lunasError.message}`);

  // Fetch Piutang non-bonus transactions
  const { data: piutangTxs, error: piutangError } = await supabaseAdmin
    .from('transactions')
    .select('*, transaction_items(*)')
    .eq('status', 'Piutang')
    .eq('is_bonus', false)
    .gte('tanggal', startDate)
    .lte('tanggal', endDate);

  if (piutangError) throw new Error(`Failed to fetch piutang: ${piutangError.message}`);

  // Fetch bonus transactions for bonus log
  const { data: bonusTxs, error: bonusError } = await supabaseAdmin
    .from('transactions')
    .select('*, transaction_items(*)')
    .eq('is_bonus', true)
    .gte('tanggal', startDate)
    .lte('tanggal', endDate);

  if (bonusError) throw new Error(`Failed to fetch bonus transactions: ${bonusError.message}`);

  // Build entries based on type
  let entries: RecapEntry[];

  switch (type) {
    case 'customer':
      entries = await buildCustomerRecap(lunasTxs || [], piutangTxs || []);
      break;
    case 'product':
      entries = await buildProductRecap(lunasTxs || [], piutangTxs || []);
      break;
    case 'overall':
      entries = await buildOverallRecap(lunasTxs || [], piutangTxs || []);
      break;
  }

  // Calculate totals
  const totals = entries.reduce(
    (acc, e) => ({
      total_omzet: acc.total_omzet + e.total_omzet,
      total_laba_hl: acc.total_laba_hl + e.total_laba_hl,
      total_piutang: acc.total_piutang + e.total_piutang,
      total_lunas: acc.total_lunas + e.total_lunas,
    }),
    { total_omzet: 0, total_laba_hl: 0, total_piutang: 0, total_lunas: 0 }
  );

  // Enrich bonus log
  const bonusLog = (bonusTxs || []).map((tx: any) => enrichTx(tx, tx.transaction_items || []));

  return {
    type,
    month,
    year,
    generated_at: new Date().toISOString(),
    entries,
    bonus_log: bonusLog,
    totals,
  };
}

// ─── Customer Recap ────────────────────────────────────────────

async function buildCustomerRecap(
  lunasTxs: any[],
  piutangTxs: any[]
): Promise<RecapEntry[]> {
  // Group by customer
  const customerMap = new Map<string, {
    name: string;
    omzetLm: D;
    omzetBr: D;
    laba: D;
    piutang: D;
    lunas: D;
  }>();

  // Process Lunas
  for (const tx of lunasTxs) {
    const customerId = tx.customer_id;
    if (!customerMap.has(customerId)) {
      const { data: cust } = await supabaseAdmin
        .from('customers')
        .select('name')
        .eq('id', customerId)
        .single();
      customerMap.set(customerId, {
        name: (cust as any)?.name || 'Unknown',
        omzetLm: new D(0),
        omzetBr: new D(0),
        laba: new D(0),
        piutang: new D(0),
        lunas: new D(0),
      });
    }

    const entry = customerMap.get(customerId)!;
    const ongkir = new D(tx.ongkir);

    for (const item of tx.transaction_items || []) {
      const itemOmzet = new D(item.line_omzet);
      entry.lunas = entry.lunas.plus(itemOmzet);
      entry.laba = entry.laba.plus(new D(item.line_laba));

      // Get product type for LM/BR split
      const { data: product } = await supabaseAdmin
        .from('products')
        .select('type')
        .eq('id', item.product_id)
        .single();

      if ((product as any)?.type === 'LM') {
        entry.omzetLm = entry.omzetLm.plus(itemOmzet);
      } else {
        entry.omzetBr = entry.omzetBr.plus(itemOmzet);
      }
    }
    entry.lunas = entry.lunas.plus(ongkir);
  }

  // Process Piutang
  for (const tx of piutangTxs) {
    const customerId = tx.customer_id;
    if (!customerMap.has(customerId)) {
      const { data: cust } = await supabaseAdmin
        .from('customers')
        .select('name')
        .eq('id', customerId)
        .single();
      customerMap.set(customerId, {
        name: (cust as any)?.name || 'Unknown',
        omzetLm: new D(0),
        omzetBr: new D(0),
        laba: new D(0),
        piutang: new D(0),
        lunas: new D(0),
      });
    }

    const entry = customerMap.get(customerId)!;
    for (const item of tx.transaction_items || []) {
      entry.piutang = entry.piutang.plus(new D(item.line_omzet));
    }
    entry.piutang = entry.piutang.plus(new D(tx.ongkir));
  }

  return Array.from(customerMap.entries()).map(([id, e]) => ({
    id,
    name: e.name,
    total_omzet: toNumber(e.omzetLm.plus(e.omzetBr)),
    total_omzet_lm: toNumber(e.omzetLm),
    total_omzet_br: toNumber(e.omzetBr),
    total_laba_hl: toNumber(e.laba),
    total_piutang: toNumber(e.piutang),
    total_lunas: toNumber(e.lunas),
  }));
}

// ─── Product Recap ─────────────────────────────────────────────

async function buildProductRecap(
  lunasTxs: any[],
  piutangTxs: any[]
): Promise<RecapEntry[]> {
  const productMap = new Map<string, {
    name: string;
    omzet: D;
    laba: D;
    type: string;
  }>();

  for (const tx of lunasTxs) {
    for (const item of tx.transaction_items || []) {
      const pid = item.product_id;
      if (!productMap.has(pid)) {
        const { data: prod } = await supabaseAdmin
          .from('products')
          .select('name, type')
          .eq('id', pid)
          .single();
        productMap.set(pid, {
          name: (prod as any)?.name || 'Unknown',
          omzet: new D(0),
          laba: new D(0),
          type: (prod as any)?.type || 'LM',
        });
      }
      const entry = productMap.get(pid)!;
      entry.omzet = entry.omzet.plus(new D(item.line_omzet));
      entry.laba = entry.laba.plus(new D(item.line_laba));
    }
  }

  return Array.from(productMap.entries()).map(([id, e]) => ({
    id,
    name: e.name,
    total_omzet: toNumber(e.omzet),
    total_omzet_lm: e.type === 'LM' ? toNumber(e.omzet) : 0,
    total_omzet_br: e.type === 'BR' ? toNumber(e.omzet) : 0,
    total_laba_hl: toNumber(e.laba),
    total_piutang: 0,
    total_lunas: toNumber(e.omzet),
  }));
}

// ─── Overall Recap ─────────────────────────────────────────────

async function buildOverallRecap(
  lunasTxs: any[],
  piutangTxs: any[]
): Promise<RecapEntry[]> {
  let totalOmzetLm = new D(0);
  let totalOmzetBr = new D(0);
  let totalLaba = new D(0);
  let totalPiutang = new D(0);
  let totalLunas = new D(0);

  for (const tx of lunasTxs) {
    const ongkir = new D(tx.ongkir);
    for (const item of tx.transaction_items || []) {
      const itemOmzet = new D(item.line_omzet);
      totalLunas = totalLunas.plus(itemOmzet);
      totalLaba = totalLaba.plus(new D(item.line_laba));

      const { data: product } = await supabaseAdmin
        .from('products')
        .select('type')
        .eq('id', item.product_id)
        .single();

      if ((product as any)?.type === 'LM') {
        totalOmzetLm = totalOmzetLm.plus(itemOmzet);
      } else {
        totalOmzetBr = totalOmzetBr.plus(itemOmzet);
      }
    }
    totalLunas = totalLunas.plus(ongkir);
  }

  for (const tx of piutangTxs) {
    for (const item of tx.transaction_items || []) {
      totalPiutang = totalPiutang.plus(new D(item.line_omzet));
    }
    totalPiutang = totalPiutang.plus(new D(tx.ongkir));
  }

  return [{
    id: 'overall',
    name: 'Total Keseluruhan',
    total_omzet: toNumber(totalOmzetLm.plus(totalOmzetBr)),
    total_omzet_lm: toNumber(totalOmzetLm),
    total_omzet_br: toNumber(totalOmzetBr),
    total_laba_hl: toNumber(totalLaba),
    total_piutang: toNumber(totalPiutang),
    total_lunas: toNumber(totalLunas),
  }];
}

// ─── PDF Export ────────────────────────────────────────────────

import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';

export async function generateRecapPdf(report: RecapReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(16).font('Helvetica-Bold')
      .text('HL Sales & Receivables Management', { align: 'center' });
    doc.fontSize(12).font('Helvetica')
      .text(`Rekap ${report.type === 'customer' ? 'Pelanggan' : report.type === 'product' ? 'Produk' : 'Keseluruhan'}`, { align: 'center' });
    doc.fontSize(10)
      .text(`Periode: ${String(report.month).padStart(2, '0')}/${report.year}`, { align: 'center' });
    doc.moveDown(1);

    // Separator
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    // Table header
    const colWidths = [150, 80, 80, 80, 80];
    const headers = ['Nama', 'Omzet', 'Laba HL', 'Piutang', 'Lunas'];
    let x = 50;
    doc.font('Helvetica-Bold').fontSize(9);
    headers.forEach((h, i) => {
      doc.text(h, x, doc.y, { width: colWidths[i], align: 'right' });
      x += colWidths[i];
    });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    // Table rows
    doc.font('Helvetica').fontSize(8);
    for (const entry of report.entries) {
      x = 50;
      const rowY = doc.y;
      const rowData = [
        entry.name,
        formatCurrency(entry.total_omzet),
        formatCurrency(entry.total_laba_hl),
        formatCurrency(entry.total_piutang),
        formatCurrency(entry.total_lunas),
      ];
      rowData.forEach((val, i) => {
        doc.text(val, x, rowY, { width: colWidths[i], align: i === 0 ? 'left' : 'right' });
        x += colWidths[i];
      });
      doc.moveDown(0.2);
    }

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    // Bonus log
    if (report.bonus_log.length > 0) {
      doc.font('Helvetica-Bold').fontSize(10).text('Bonus Log');
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(8);
      for (const bt of report.bonus_log) {
        doc.text(`Bon: ${bt.nomor_bon} | Tanggal: ${bt.tanggal} | Customer: ${bt.customer_id}`);
      }
      doc.moveDown(0.5);
    }

    // Totals
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text(`Total Omzet: ${formatCurrency(report.totals.total_omzet)}`);
    doc.text(`Total Laba HL: ${formatCurrency(report.totals.total_laba_hl)}`);
    doc.text(`Total Piutang: ${formatCurrency(report.totals.total_piutang)}`);
    doc.text(`Total Lunas: ${formatCurrency(report.totals.total_lunas)}`);

    // Signature block
    doc.moveDown(3);
    doc.font('Helvetica').fontSize(9);
    doc.text('Dibuat oleh: _________________________', 50);
    doc.moveDown(1);
    doc.text('Disetujui oleh: _________________________', 50);
    doc.moveDown(1);
    doc.text(`Tanggal: ${new Date().toLocaleDateString('id-ID')}`, 50);

    doc.end();
  });
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function enrichTx(tx: any, items: any[]): TransactionWithItems {
  const txOmzet = items.reduce((sum: D, item: any) => sum.plus(new D(item.line_omzet)), new D(0));
  const txLaba = items.reduce((sum: D, item: any) => sum.plus(new D(item.line_laba)), new D(0));
  const ongkir = new D(tx.ongkir);

  return {
    ...tx,
    items,
    total_omzet: toNumber(txOmzet),
    total_laba: toNumber(txLaba),
    amount_owed: toNumber(txOmzet.plus(ongkir)),
  };
}
