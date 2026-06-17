// ─── AI Routes (Gemini API) ─────────────────────────────────────

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import * as aiService from '../services/ai';
import { sendSuccess } from '../utils/response';
import { ValidationError } from '../utils/errors';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// POST /api/ai/reminder — Generate WA payment reminder
router.post('/reminder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { customerId, transactionId } = req.body;
    if (!customerId) {
      throw new ValidationError('customerId is required');
    }

    const message = await aiService.generatePaymentReminder(customerId, transactionId);
    sendSuccess(res, { message }, 'Reminder drafted successfully');
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/chat — Chatbot financial advisor query
router.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { message } = req.body;
    if (!message) {
      throw new ValidationError('message is required');
    }

    const reply = await aiService.answerFinancialQuery(message);
    sendSuccess(res, { reply }, 'AI responded successfully');
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/risk — Analisis risiko piutang semua pelanggan
router.get('/risk', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const risks = await aiService.analyzeCustomerRisk();
    sendSuccess(res, risks);
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/predictions — Prediksi kapan pelanggan akan bayar
router.get('/predictions', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const predictions = await aiService.predictPayments();
    sendSuccess(res, predictions);
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/overdue — Daftar bon overdue beserta info pelanggan
router.get('/overdue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = req.query.days ? Number(req.query.days) : 14;
    const alerts = await aiService.getOverdueAlerts(days);
    sendSuccess(res, alerts);
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/anomalies — Deteksi transaksi anomali
router.get('/anomalies', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const anomalies = await aiService.detectAnomalies();
    sendSuccess(res, anomalies);
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/daily-summary — Ringkasan bisnis harian (AI-generated)
router.get('/daily-summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await aiService.getDailySummary();
    sendSuccess(res, { summary });
  } catch (err) {
    next(err);
  }
});

export default router;
