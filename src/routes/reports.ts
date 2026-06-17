// ─── Report Routes ─────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { recapQuerySchema } from '../middleware/validation';
import * as reportService from '../services/report';
import { sendSuccess } from '../utils/response';
import { ValidationError } from '../utils/errors';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// GET /reports/recap?type=customer|product|overall&month=XX&year=XXXX
router.get('/recap', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = recapQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const report = await reportService.getRecap(parsed.data.type, parsed.data.month, parsed.data.year);
    sendSuccess(res, report);
  } catch (err) {
    next(err);
  }
});

// POST /reports/export-pdf — Generate PDF from recap data
router.post('/export-pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, month, year } = req.body;

    if (!type || !month || !year) {
      throw new ValidationError('type, month, and year are required');
    }

    if (!['customer', 'product', 'overall'].includes(type)) {
      throw new ValidationError('type must be customer, product, or overall');
    }

    const report = await reportService.getRecap(type, Number(month), Number(year));
    const pdfBuffer = await reportService.generateRecapPdf(report);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="recap-${type}-${month}-${year}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

export default router;
