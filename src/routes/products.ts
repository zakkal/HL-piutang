// ─── Product Routes ────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { createProductSchema, updateProductSchema } from '../middleware/validation';
import * as productService from '../services/product';
import { sendSuccess, sendError } from '../utils/response';
import { ValidationError } from '../utils/errors';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// GET /products — List active products
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const products = await productService.listProducts();
    sendSuccess(res, products);
  } catch (err) {
    next(err);
  }
});

// GET /products/:id — Get single product
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await productService.getProduct(req.params.id as string);
    sendSuccess(res, product);
  } catch (err) {
    next(err);
  }
});

// POST /products — Create product
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const product = await productService.createProduct(parsed.data);
    sendSuccess(res, product, 'Product created', 201);
  } catch (err) {
    next(err);
  }
});

// PUT /products/:id — Update product
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = updateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const product = await productService.updateProduct(req.params.id as string, parsed.data);
    sendSuccess(res, product, 'Product updated');
  } catch (err) {
    next(err);
  }
});

// DELETE /products/:id — Soft delete product
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await productService.softDeleteProduct(req.params.id as string);
    sendSuccess(res, null, 'Product deleted (soft)');
  } catch (err) {
    next(err);
  }
});

export default router;
