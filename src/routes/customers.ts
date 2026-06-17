// ─── Customer Routes ───────────────────────────────────────────

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { createCustomerSchema, updateCustomerSchema } from '../middleware/validation';
import * as customerService from '../services/customer';
import { sendSuccess, sendError } from '../utils/response';
import { ValidationError } from '../utils/errors';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// GET /customers — List active customers with effective discount
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const customers = await customerService.listCustomers();
    sendSuccess(res, customers);
  } catch (err) {
    next(err);
  }
});

// GET /customers/:id — Get single customer
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customer = await customerService.getCustomer(req.params.id as string);
    sendSuccess(res, customer);
  } catch (err) {
    next(err);
  }
});

// POST /customers — Create customer
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createCustomerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const customer = await customerService.createCustomer(parsed.data);
    sendSuccess(res, customer, 'Customer created', 201);
  } catch (err) {
    next(err);
  }
});

// PUT /customers/:id — Update customer
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = updateCustomerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const customer = await customerService.updateCustomer(req.params.id as string, parsed.data);
    sendSuccess(res, customer, 'Customer updated');
  } catch (err) {
    next(err);
  }
});

// DELETE /customers/:id — Soft delete customer
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await customerService.softDeleteCustomer(req.params.id as string);
    sendSuccess(res, null, 'Customer deleted (soft)');
  } catch (err) {
    next(err);
  }
});

export default router;
