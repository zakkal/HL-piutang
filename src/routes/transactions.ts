// ─── Transaction Routes ────────────────────────────────────────

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  createTransactionSchema,
  settleTransactionSchema,
  settleMonthSchema,
  activityQuerySchema,
} from '../middleware/validation';
import * as transactionService from '../services/transaction';
import * as customerService from '../services/customer';
import { sendSuccess } from '../utils/response';
import { ValidationError } from '../utils/errors';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// POST /transactions — Create transaction
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createTransactionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const transaction = await transactionService.createTransaction(parsed.data);
    sendSuccess(res, transaction, 'Transaction created', 201);
  } catch (err) {
    next(err);
  }
});

// GET /customers/:id/activity — Customer activity summary
router.get('/customers/:id/activity', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = activityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const activity = await transactionService.getCustomerActivity(
      req.params.id as string,
      parsed.data.month,
      parsed.data.year
    );
    sendSuccess(res, activity);
  } catch (err) {
    next(err);
  }
});

// POST /customers/:id/settle-month — Settle all piutang for a month
router.post('/customers/:id/settle-month', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = settleMonthSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const result = await transactionService.settleMonth(
      req.params.id as string,
      parsed.data.month,
      parsed.data.year
    );
    sendSuccess(res, result, `${result.settled_count} transactions settled`);
  } catch (err) {
    next(err);
  }
});

// GET /customers/:id/bonus-status — Get bonus status for customer
router.get('/customers/:id/bonus-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bonusStatus = await transactionService.getBonusStatus(req.params.id as string);
    sendSuccess(res, bonusStatus);
  } catch (err) {
    next(err);
  }
});

// POST /transactions/:id/settle — Settle single transaction
router.post('/:id/settle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = settleTransactionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const transaction = await transactionService.settleTransaction(
      req.params.id as string,
      parsed.data.tanggal_pelunasan
    );
    sendSuccess(res, transaction, 'Transaction settled');
  } catch (err) {
    next(err);
  }
});

// GET /transactions/:id — Get transaction with items (MUST be last - catches all /:id)
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const transaction = await transactionService.getTransactionWithItems(req.params.id as string);
    sendSuccess(res, transaction);
  } catch (err) {
    next(err);
  }
});

export default router;
