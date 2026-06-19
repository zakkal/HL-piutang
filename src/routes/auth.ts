// ─── Auth Routes ───────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { loginSchema } from '../middleware/validation';
import { sendSuccess, sendError } from '../utils/response';
import { ValidationError } from '../utils/errors';
import { loginRateLimiter } from '../middleware/rateLimiter';

const router = Router();
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

// POST /auth/login
router.post('/login', loginRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const { email, password } = parsed.data;

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      return sendError(res, 'Invalid email or password', undefined, 401);
    }

    sendSuccess(res, {
      access_token: data.session?.access_token,
      refresh_token: data.session?.refresh_token,
      expires_at: data.session?.expires_at,
      user: {
        id: data.user?.id,
        email: data.user?.email,
      },
    }, 'Login successful');
  } catch (err) {
    next(err);
  }
});

// POST /auth/change-password
router.post('/change-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      throw new ValidationError('Password baru minimal 6 karakter');
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return sendError(res, 'Unauthorized', undefined, 401);
    }

    const token = authHeader.substring(7);
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      return sendError(res, error.message, undefined, 400);
    }

    sendSuccess(res, null, 'Password berhasil diubah');
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      await supabase.auth.signOut();
    }
    sendSuccess(res, null, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
});

export default router;
