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

// ─── PDF Export: Rekap Bulanan ────────────────────────────────

import PDFDocument from 'pdfkit';

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

const MONTHS_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

function formatCurrency(amount: number): string {
  return 'Rp ' + new Intl.NumberFormat('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number, cols: number[], headers: string[]) {
  doc.font('Helvetica-Bold').fontSize(8);
  let x = 50;
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: cols[i], align: i === 0 ? 'left' : 'right' });
    x += cols[i];
  });
  const lineY = y + 14;
  doc.moveTo(50, lineY).lineTo(545, lineY).strokeColor('#cccccc').stroke();
  doc.strokeColor('black');
  return lineY + 4;
}

function drawTableRow(doc: PDFKit.PDFDocument, y: number, cols: number[], values: string[], shade: boolean) {
  if (shade) {
    doc.rect(50, y - 2, 495, 16).fillColor('#f5f5f5').fill();
    doc.fillColor('black');
  }
  doc.font('Helvetica').fontSize(8);
  let x = 50;
  values.forEach((v, i) => {
    doc.text(v, x, y, { width: cols[i], align: i === 0 ? 'left' : 'right' });
    x += cols[i];
  });
  return y + 16;
}

export async function generateRecapPdf(report: RecapReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const typeLabel = report.type === 'customer' ? 'Per Pelanggan' : report.type === 'product' ? 'Per Produk' : 'Keseluruhan';
    const periodLabel = `${MONTHS_ID[report.month - 1]} ${report.year}`;

    // ── Header bar ──
    doc.rect(0, 0, doc.page.width, 75).fillColor('#111111').fill();
    doc.fillColor('white').fontSize(16).font('Helvetica-Bold').text('HL Sales & Receivables', 50, 16);
    doc.fontSize(10).font('Helvetica').text(`Rekap ${typeLabel}  ·  ${periodLabel}`, 50, 40);
    doc.fillColor('black');
    doc.y = 90;

    doc.fontSize(8).font('Helvetica').fillColor('#888888')
      .text(`Dicetak: ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`, { align: 'right' });
    doc.fillColor('black');
    doc.moveDown(0.5);

    // ── Summary boxes ──
    const totals = report.totals;
    const summaryY = doc.y;
    const boxW = 115;
    [
      { label: 'Total Omzet', value: formatCurrency(totals.total_omzet) },
      { label: 'Total Laba HL', value: formatCurrency(totals.total_laba_hl) },
      { label: 'Total Piutang', value: formatCurrency(totals.total_piutang) },
      { label: 'Total Lunas', value: formatCurrency(totals.total_lunas) },
    ].forEach((s, i) => {
      const bx = 50 + i * (boxW + 5);
      doc.rect(bx, summaryY, boxW, 38).fillColor('#f2f2f2').fill();
      doc.fillColor('#777777').fontSize(7).font('Helvetica').text(s.label, bx + 6, summaryY + 5, { width: boxW - 12 });
      doc.fillColor('#111111').fontSize(8).font('Helvetica-Bold').text(s.value, bx + 6, summaryY + 17, { width: boxW - 12 });
    });
    doc.fillColor('black');
    doc.y = summaryY + 48;
    doc.moveDown(0.5);

    // ── Tabel ──
    const cols = [160, 80, 80, 80, 80];
    const headers = ['Nama', 'Omzet', 'Laba HL', 'Piutang', 'Lunas'];
    let rowY = drawTableHeader(doc, doc.y, cols, headers);

    report.entries.forEach((entry, idx) => {
      if (rowY > 730) {
        doc.addPage();
        rowY = 50;
        rowY = drawTableHeader(doc, rowY, cols, headers);
      }
      rowY = drawTableRow(doc, rowY, cols, [
        entry.name,
        formatCurrency(entry.total_omzet),
        formatCurrency(entry.total_laba_hl),
        formatCurrency(entry.total_piutang),
        formatCurrency(entry.total_lunas),
      ], idx % 2 === 1);
    });

    // Total row
    doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor('#aaaaaa').stroke();
    doc.strokeColor('black');
    rowY += 4;
    if (rowY > 730) { doc.addPage(); rowY = 50; }
    doc.rect(50, rowY - 2, 495, 16).fillColor('#222222').fill();
    doc.fillColor('white').font('Helvetica-Bold').fontSize(8);
    let tx2 = 50;
    ['TOTAL', formatCurrency(totals.total_omzet), formatCurrency(totals.total_laba_hl), formatCurrency(totals.total_piutang), formatCurrency(totals.total_lunas)].forEach((v, i) => {
      doc.text(v, tx2, rowY, { width: cols[i], align: i === 0 ? 'left' : 'right' });
      tx2 += cols[i];
    });
    doc.fillColor('black');
    rowY += 20;

    // ── Bonus log ──
    if (report.bonus_log.length > 0) {
      if (rowY > 700) { doc.addPage(); rowY = 50; }
      doc.y = rowY + 10;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#333333').text('Bonus Log');
      doc.moveDown(0.2);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(8).fillColor('black');
      report.bonus_log.forEach((bt, idx) => {
        if (doc.y > 730) doc.addPage();
        if (idx % 2 === 1) {
          doc.rect(50, doc.y - 2, 495, 13).fillColor('#f5f5f5').fill().fillColor('black');
        }
        doc.text(`${bt.nomor_bon}    ${bt.tanggal}    ${bt.customer_id.slice(0, 12)}...`, 55, doc.y);
        doc.moveDown(0.2);
      });
    }

    doc.end();
  });
}

// ─── PDF Export: Customer Activity Per Bulan ─────────────────

export async function generateCustomerActivityPdf(
  activity: any,
  customerName: string,
  month: number,
  year: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const periodLabel = `${MONTHS_ID[month - 1]} ${year}`;

    // ── Header ──
    doc.rect(0, 0, doc.page.width, 75).fillColor('#111111').fill();
    doc.fillColor('white').fontSize(16).font('Helvetica-Bold').text('HL Sales & Receivables', 50, 16);
    doc.fontSize(10).font('Helvetica').text(`Aktivitas: ${customerName}  ·  ${periodLabel}`, 50, 40);
    doc.fillColor('black');
    doc.y = 90;

    doc.fontSize(8).font('Helvetica').fillColor('#888888')
      .text(`Dicetak: ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`, { align: 'right' });
    doc.fillColor('black');
    doc.moveDown(0.5);

    // ── Summary boxes ──
    const summaryY = doc.y;
    const boxW = 91;
    [
      { label: 'Piutang', value: formatCurrency(activity.total_piutang) },
      { label: 'Lunas', value: formatCurrency(activity.total_lunas) },
      { label: 'Omzet LM', value: formatCurrency(activity.total_omzet_lm) },
      { label: 'Omzet BR', value: formatCurrency(activity.total_omzet_br) },
      { label: 'Laba HL', value: formatCurrency(activity.total_laba_hl) },
    ].forEach((s, i) => {
      const bx = 50 + i * (boxW + 4);
      doc.rect(bx, summaryY, boxW, 38).fillColor('#f2f2f2').fill();
      doc.fillColor('#777777').fontSize(7).font('Helvetica').text(s.label, bx + 5, summaryY + 5, { width: boxW - 10 });
      doc.fillColor('#111111').fontSize(8).font('Helvetica-Bold').text(s.value, bx + 5, summaryY + 17, { width: boxW - 10 });
    });
    doc.fillColor('black');
    doc.y = summaryY + 48;
    doc.moveDown(0.5);

    // ── Tabel transaksi ──
    const cols = [65, 90, 170, 65, 80];
    const headers = ['Tanggal', 'No. Bon', 'Item', 'Status', 'Tagihan'];
    let rowY = drawTableHeader(doc, doc.y, cols, headers);

    const txs = activity.transactions || [];
    txs.forEach((tx: any, idx: number) => {
      if (rowY > 730) {
        doc.addPage();
        rowY = 50;
        rowY = drawTableHeader(doc, rowY, cols, headers);
      }

      const itemNames = (tx.items || []).map((item: any) => {
        const name = item.products?.name || `Produk ${item.product_id.slice(0, 6)}`;
        return `${name} ×${item.quantity}`;
      }).join(', ') || '—';

      rowY = drawTableRow(doc, rowY, cols, [
        tx.tanggal,
        tx.nomor_bon,
        itemNames,
        tx.status + (tx.is_bonus ? ' (Bonus)' : ''),
        formatCurrency(tx.amount_owed),
      ], idx % 2 === 1);
    });

    doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor('#aaaaaa').stroke();
    doc.end();
  });
}

export interface MonthlyChartPoint {
  month: number;
  year: number;
  label: string;
  omzet: number;
  piutang: number;
  lunas: number;
  laba: number;
}

export async function getMonthlyChartData(): Promise<MonthlyChartPoint[]> {
  const result: MonthlyChartPoint[] = [];
  const now = new Date();

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    const label = d.toLocaleDateString('id-ID', { month: 'short', year: '2-digit' });

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const { data: lunasTxs } = await supabaseAdmin
      .from('transactions')
      .select('ongkir, transaction_items(line_omzet, line_laba)')
      .eq('status', 'Lunas')
      .eq('is_bonus', false)
      .gte('tanggal', startDate)
      .lte('tanggal', endDate);

    const { data: piutangTxs } = await supabaseAdmin
      .from('transactions')
      .select('ongkir, transaction_items(line_omzet)')
      .eq('status', 'Piutang')
      .eq('is_bonus', false)
      .gte('tanggal', startDate)
      .lte('tanggal', endDate);

    let omzet = 0, laba = 0, lunas = 0, piutang = 0;

    for (const tx of (lunasTxs || []) as any[]) {
      const txOmzet = (tx.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_omzet || 0), 0);
      const txLaba = (tx.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_laba || 0), 0);
      omzet += txOmzet;
      laba += txLaba;
      lunas += txOmzet + Number(tx.ongkir || 0);
    }

    for (const tx of (piutangTxs || []) as any[]) {
      const txOmzet = (tx.transaction_items || []).reduce((s: number, i: any) => s + Number(i.line_omzet || 0), 0);
      piutang += txOmzet + Number(tx.ongkir || 0);
    }

    result.push({ month, year, label, omzet, piutang, lunas, laba });
  }

  return result;
}
